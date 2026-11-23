// 合成来源客户端。
// 两种传输：
//  - http：对接 source.mjs 的 /v1/{release}/{resource}；
//  - file：直接读 wire/ 目录与 wire.json 路由清单（离线/测试用，载荷字节一致）。
// 协议要点：未发布页返回 404 -> 采集端记为 missing（缺联），服务不可用 503 -> 可重试错误。
import { readFile } from 'node:fs/promises';
import { parseCsv } from './csv.mjs';

export const RESOURCES = ['dispatch-index', 'train-a', 'train-b', 'train-c', 'changes', 'registry', 'scale', 'yard', 'terms', 'ledger'];
export const PHASES = ['opening', 'interim', 'confirmed'];

export class SourceError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.details = details;
  }
}

export class HttpSource {
  constructor(baseUrl, fetchImpl = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async get(phase, resource) {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/${phase}/${resource}`);
    if (res.status === 404) return { status: 404, missing: true, body: null };
    if (res.status === 503) throw new SourceError('来源服务暂不可用', 'SOURCE_UNAVAILABLE', { phase, resource });
    if (!res.ok) throw new SourceError(`来源返回 ${res.status}`, 'SOURCE_BAD_STATUS', { phase, resource, status: res.status });
    const type = res.headers.get('content-type') ?? '';
    return {
      status: 200,
      release: res.headers.get('x-release'),
      contentType: type,
      body: type.includes('json') ? await res.json() : await res.text(),
    };
  }

  /** 门户 POST；同 key 同报文重发按原回执返回（200），异报文返回 409。 */
  async portal(phase, payload) {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/${phase}/portal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await res.json(); } catch { /* 门户异常时可能无 JSON */ }
    if (res.status === 503) throw new SourceError('门户未能及时回传回执', 'PORTAL_UNAVAILABLE', { key: payload.key });
    if (res.status === 409) throw new SourceError('请求号已对应其他报文', 'PORTAL_KEY_CONFLICT', { key: payload.key });
    if (![200, 201].includes(res.status)) {
      throw new SourceError(`门户返回 ${res.status}`, 'PORTAL_BAD_STATUS', { status: res.status, body });
    }
    return { status: res.status, duplicate: res.status === 200, receipt: body };
  }
}

export class FileSource {
  /** @param {string} wireDir wire 目录绝对路径 @param {object} manifest wire.json 内容 */
  constructor(wireDir, manifest) {
    this.wireDir = wireDir;
    this.manifest = manifest;
  }

  async get(phase, resource) {
    const table = this.manifest.releases[phase];
    if (!table || !Object.hasOwn(table, resource)) {
      return { status: 404, missing: true, body: null };
    }
    const entry = table[resource];
    if (entry.status) throw new SourceError('发布方暂不可用', 'SOURCE_UNAVAILABLE', { phase, resource });
    const text = await readFile(`${this.wireDir}/${entry.name}`, 'utf8');
    return {
      status: 200,
      release: phase,
      contentType: entry.type,
      body: entry.type === 'application/json' ? JSON.parse(text) : text,
    };
  }

  // 文件模式没有真实门户；本地存储的 portal 幂等逻辑由 PortalBook 承担。
  async portal() {
    throw new SourceError('文件模式不支持门户，请使用 HttpSource', 'PORTAL_UNSUPPORTED');
  }
}

/** 把一次 GET 结果转成领域可用结构；CSV 在此解析。 */
export function decodeResource(resource, envelope) {
  if (envelope.missing) return { resource, missing: true };
  if (resource === 'scale') {
    return { resource, missing: false, rows: parseCsv(envelope.body) };
  }
  return { resource, missing: false, data: envelope.body };
}
