import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const phases = ['opening', 'interim', 'confirmed'];
const load = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

function reply(res, status, value, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8' });
  res.end(type === 'application/json' ? JSON.stringify(value) : value);
}

export function makeSource() {
  const manifest = load('./wire.json');
  const requests = new Map();

  return createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const match = /^\/v1\/(opening|interim|confirmed)\/([a-z0-9-]+)$/.exec(path);
    if (!match) {
      return reply(res, 404, { message: '接口不存在' });
    }

    const [, phase, resource] = match;
    res.setHeader('X-Release', phase);
    if (req.method === 'GET' && resource !== 'portal') {
      const file = manifest.releases[phase][resource];
      if (!Object.hasOwn(manifest.releases[phase], resource)) return reply(res, 404, { message: '发布方尚未交付此页' });
      if (file.status) return reply(res, file.status, { message: '发布方暂不可用' });
      return reply(res, 200, file.type === 'application/json'
        ? load('./wire/' + file.name)
        : readFileSync(new URL('./wire/' + file.name, import.meta.url), 'utf8'),
      file.type);
    }

    if (resource !== 'portal' || req.method !== 'POST') {
      return reply(res, 405, { message: '接口不支持此请求方式' });
    }

    let payload;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) return reply(res, 413, { message: '请求过大' });
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(res, 400, { message: '请提交 JSON 请求' });
    }

    const action = payload?.action;
    const key = payload?.key;
    if (typeof key !== 'string' || !key.trim() || !Object.hasOwn(manifest.actions, action)) {
      return reply(res, 422, { message: '无有效请求号或操作' });
    }
    if (action === 'inspect') {
      const previous = requests.get(key);
      const recorded = Object.hasOwn(manifest.known[phase], key) ? manifest.known[phase][key] : undefined;
      if (previous) {
        const { input, operation, ...output } = previous;
        const confirmedState = manifest.inspectStates[operation];
        if (phase === 'confirmed' && confirmedState) output[manifest.statusField] = confirmedState;
        return reply(res, 200, { key, ...output });
      }
      if (recorded) return reply(res, 200, { key, ...recorded });
      return reply(res, 404, { message: '门户未收到此请求' });
    }
    const previous = requests.get(key);
    const input = JSON.stringify(payload);
    if (previous) {
      if (previous.input !== input) return reply(res, 409, { message: '请求号已对应其他报文' });
      const { input: ignored, operation, ...output } = previous;
      return reply(res, 200, { key, ...output });
    }

    const response = { ...manifest.actions[action], sourceRef: phase + '-' + (requests.size + 1) };
    requests.set(key, { ...response, input, operation: action });
    if (phase === 'interim' && manifest.lateAction === action) {
      return reply(res, 503, { message: '门户未能及时回传回执' });
    }
    return reply(res, 201, { key, ...response });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = makeSource();
  server.listen(Number(process.env.SOURCE_PORT ?? 4173), '127.0.0.1', () => {
    console.log('合成来源已启动，端口 ' + server.address().port + '，可用阶段 ' + phases.join('、'));
  });
}
