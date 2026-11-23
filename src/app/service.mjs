// 应用服务：从事件存储重建全部读模型，串起谱系→占用→计费→对账→进度。
// 纯函数式重建，保证任何时刻重跑结果一致；确认与冲抵单独留痕。
import { IdentityResolver } from '../domain/identity.mjs';
import { mergeWeighVouchers, unloadSegmentsByWagon, receivedKgByWagon } from '../domain/vouchers.mjs';
import { buildLineage } from '../domain/lineage.mjs';
import { buildOccupancy } from '../domain/occupancy.mjs';
import { billOccupancy, normalizeTerms } from '../domain/billing.mjs';
import { reconcile, buildReversal, crossCheckLedger } from '../domain/reconciliation.mjs';
import { buildWaybillProgress, buildShiftHandoff } from '../domain/progress.mjs';

/**
 * 重建读模型。
 * @param {JsonEventStore} store
 * @param {object} [opts]
 * @param {string} [opts.asOf] 待核暂估的观察时刻
 */
export function rebuild(store, opts = {}) {
  const b = store.replay();
  if (!b.index) {
    return { ready: false, reason: '尚未采集 dispatch-index', models: null };
  }
  // 待核暂估：显式 asOf 固定快照（测试/复算）；缺省由计费层按最新凭据/当前时刻处理。
  const asOf = opts.asOf ?? null;

  const identity = new IdentityResolver(b.registry);
  const { vouchers, warnings: voucherWarnings } = mergeWeighVouchers(b.scaleRows, identity);
  const segmentsByWagon = unloadSegmentsByWagon(vouchers);
  const receivedByWagon = receivedKgByWagon(segmentsByWagon);

  // 缺页：索引声明但存储中没有对应页 -> null，谱系按缺联处理。
  const pagesByName = new Map();
  b.index.pages.forEach((page) => {
    pagesByName.set(page, b.dispatchPages.has(page) ? b.dispatchPages.get(page) : null);
  });

  const lineage = buildLineage(b.index, pagesByName, b.changes, receivedByWagon);

  const occupancyByWagon = new Map();
  const bills = [];
  const terms = normalizeTerms(b.terms ?? { freeMinutes: 0, fenPerMinute: 0 });

  for (const link of lineage.wagonLinks) {
    if (link.linkStatus === 'missing') continue; // 缺联车没有任何占用事实
    const wagon = link.wagon;
    const yardRows = b.yard.filter((y) => y.wagon === wagon);
    const gateRows = b.gates.filter((g) => g.wagon === wagon);
    const segments = segmentsByWagon.get(wagon) ?? [];
    const occupancy = buildOccupancy(wagon, yardRows, gateRows, segments);
    occupancyByWagon.set(wagon, occupancy);
    bills.push(billOccupancy(occupancy, terms, asOf));
  }

  const reconciliation = reconcile(bills);
  const progress = buildWaybillProgress(lineage, occupancyByWagon, segmentsByWagon);
  const ledgerCheck = b.ledger.length ? crossCheckLedger(b.ledger, reconciliation.confirmedLines) : { matches: [], disputes: [] };

  return {
    ready: true,
    models: {
      identity,
      vouchers,
      voucherWarnings,
      segmentsByWagon,
      lineage,
      occupancyByWagon,
      bills,
      reconciliation,
      progress,
      ledgerCheck,
    },
  };
}

/** 确认所有当前证据完整的对账行；未确认车不影响同运单其他车。 */
export function confirmEligible(store) {
  const { models } = rebuild(store);
  const added = [];
  for (const line of models.reconciliation.confirmedLines) {
    if (store.addConfirmation(line)) added.push(line.lineId);
  }
  return added;
}

/**
 * 更正处理：当新采集的事实（如 release 被 Y2A 替代）影响已确认行，
 * 生成可追溯的待冲抵包并留痕。
 */
export function processCorrections(store) {
  const built = rebuild(store);
  if (!built.ready) return [];
  const out = [];
  for (const confirmed of store.state.confirmations) {
    const fresh = built.models.bills.find((x) => x.wagon === confirmed.wagon);
    if (!fresh || fresh.state !== 'confirmed') continue;
    const changed = fresh.startRef !== confirmed.startRef
      || fresh.endRef !== confirmed.endRef
      || fresh.chargeableMinutes !== confirmed.chargeableMinutes
      || fresh.fen !== confirmed.fen;
    if (!changed) continue;
    const triggerRef = fresh.evidence.supersededRefs[0]?.supersededBy ?? `correction-${confirmed.wagon}`;
    const reversal = buildReversal(confirmed, fresh, {
      kind: 'yard-release-supersede',
      ref: triggerRef,
      detail: { oldEndRef: confirmed.endRef, newEndRef: fresh.endRef },
    });
    if (store.addReversal(reversal)) out.push(reversal);
  }
  return out;
}

export function shiftHandoff(store, shiftId, takenAt) {
  const { models } = rebuild(store);
  if (!models) throw new Error('数据未就绪，无法生成交接');
  return buildShiftHandoff(models.progress, shiftId, takenAt);
}
