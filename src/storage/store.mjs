// 本地事件存储：原始凭据只追加、不修改；更正以新事件 + supersedes 表达。
// 同时维护一个可整体读取的快照，供领域模块重建视图。JSON 文件原子写入。
import { readFile, writeFile, mkdir, access, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const CURRENT_VERSION = 1;

export function createEmptyStore() {
  return {
    version: CURRENT_VERSION,
    events: [], // 全部原始/补件事件，仅追加
    confirmations: [], // 已确认对账行（冻结）
    reversals: [], // 待冲抵/已冲抵包
    portalReceipts: [], // 门户回执留痕
  };
}

export class JsonEventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = createEmptyStore();
    this.loaded = false;
  }

  async load() {
    try {
      await access(this.filePath);
    } catch {
      this.state = createEmptyStore();
      this.loaded = true;
      return this.state;
    }
    const text = await readFile(this.filePath, 'utf8');
    this.state = text.trim() ? JSON.parse(text) : createEmptyStore();
    this.loaded = true;
    return this.state;
  }

  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(tmp, this.filePath);
    await rm(tmp, { force: true }).catch(() => {});
  }

  /** 追加原始事件；同一来源同 ref 且内容一致视为重复采集，不重复入账。 */
  record(event) {
    const key = `${event.source}:${event.ref ?? event.resource ?? ''}`;
    const dup = this.state.events.find((e) => `${e.source}:${e.ref ?? e.resource ?? ''}` === key
      && JSON.stringify(e.payload) === JSON.stringify(event.payload));
    if (dup) return { appended: false, eventId: dup.eventId };
    const eventId = `E${(this.state.events.length + 1).toString().padStart(5, '0')}`;
    this.state.events.push({ eventId, recordedAt: new Date().toISOString(), ...event });
    return { appended: true, eventId };
  }

  addConfirmation(line) {
    if (this.state.confirmations.some((c) => c.lineId === line.lineId)) return false;
    this.state.confirmations.push({ confirmedAt: new Date().toISOString(), ...line });
    return true;
  }

  addReversal(reversal) {
    if (this.state.reversals.some((r) => r.reversalId === reversal.reversalId)) return false;
    this.state.reversals.push({ recordedAt: new Date().toISOString(), ...reversal });
    return true;
  }

  addPortalReceipt(receipt) {
    this.state.portalReceipts.push({ at: new Date().toISOString(), ...receipt });
  }

  /** 按来源类型重放事件，输出领域模块需要的集合。多阶段重复发布按业务主键去重。 */
  replay() {
    const buckets = {
      dispatchPages: new Map(), // pageName -> rows[]
      index: null,
      changes: [],
      registry: [],
      scaleRows: [],
      yard: [],
      gates: [],
      terms: null,
      ledger: [],
    };

    const dedupBy = (list, rows, keyFn) => {
      const existing = new Set(list.map(keyFn));
      rows.forEach((row) => {
        const k = keyFn(row);
        if (!existing.has(k)) {
          existing.add(k);
          list.push(row);
        }
      });
    };

    for (const e of this.state.events) {
      switch (e.source) {
        case 'dispatch-index':
          buckets.index = e.payload;
          break;
        case 'dispatch-page':
          // 同名页以最新发布为准（D2 保留原始发车页，页内容本身稳定）
          buckets.dispatchPages.set(e.payload.page, e.payload.rows);
          break;
        case 'changes':
          dedupBy(buckets.changes, e.payload, (r) => r.ref);
          break;
        case 'registry':
          // 无业务主键，按整行指纹去重（多阶段重复发布的同一条对应）
          dedupBy(buckets.registry, e.payload, (r) => JSON.stringify(r));
          break;
        case 'scale':
          // 磅单的重复/补登归并在凭据层处理，此处保留全部原始行
          buckets.scaleRows.push(...e.payload);
          break;
        case 'yard':
          dedupBy(buckets.yard, e.payload, (r) => r.ref);
          break;
        case 'gate':
          dedupBy(buckets.gates, e.payload, (r) => r.ref);
          break;
        case 'terms':
          buckets.terms = e.payload;
          break;
        case 'ledger':
          dedupBy(buckets.ledger, e.payload, (r) => r.line);
          break;
        default:
          break;
      }
    }
    return buckets;
  }
}
