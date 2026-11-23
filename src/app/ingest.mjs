// 采集编排：按阶段把来源各资源落入仅追加事件存储。
// 缺页（404）只登记 missing 标记，绝不生成“车辆脱运单”事件；后续阶段补页后自然接上。
import { RESOURCES, decodeResource } from '../source/client.mjs';

/**
 * @param {object} source HttpSource | FileSource
 * @param {JsonEventStore} store
 * @param {string} phase opening | interim | confirmed
 */
export async function ingestPhase(source, store, phase) {
  const result = { phase, ingested: [], missing: [], failed: [] };

  for (const resource of RESOURCES) {
    let envelope;
    try {
      envelope = await source.get(phase, resource);
    } catch (err) {
      result.failed.push({ resource, code: err.code, message: err.message });
      continue;
    }
    const decoded = decodeResource(resource, envelope);
    if (decoded.missing) {
      result.missing.push({ resource });
      store.record({ source: 'missing-marker', resource, phase, payload: { phase, resource } });
      continue;
    }

    if (resource === 'dispatch-index') {
      store.record({ source: 'dispatch-index', ref: `${phase}-${decoded.data.version}`, phase, payload: decoded.data });
    } else if (resource.startsWith('train-')) {
      store.record({ source: 'dispatch-page', ref: `${phase}-${resource}`, phase, payload: { page: resource, rows: decoded.data } });
    } else {
      const payload = resource === 'scale' ? decoded.rows : decoded.data;
      store.record({ source: resource, ref: phase, phase, payload });
    }
    result.ingested.push(resource);
  }

  await store.persist();
  return result;
}

/** 手工登记门禁（允许晚写入）；来源可为现场补录。 */
export function recordGates(store, gateRows, sourceRef) {
  const outcomes = gateRows.map((g) => store.record({
    source: 'gate',
    ref: g.ref,
    phase: 'manual',
    payload: [g],
  }));
  void sourceRef;
  return outcomes;
}
