// 对账与冲抵。
// 规则：
//  - 证据完整（take+release 都确认）的车可按原账期立即确认，
//    同运单另有车辆未核完不得连带挂起（逐车独立确认）；
//  - 终点未确认的车只出 pending 行，可暂估、不可发最终对账行；
//  - 车辆号对应更正或换装补件触及已确认行时，按原计费区间生成 reversal（待冲抵范围），
//    新事实另算 replacement；冲抵必须能追溯原 lineId、原凭据与原区间；
//  - 月底财务用自有压车单（ledger）回查：按车号+起止凭据比对，差异列为 dispute。
import { stableId } from './util.mjs';

/**
 * 汇总全部车的计费结果为对账视图。
 * @param {Array} billResults billOccupancy 的结果数组
 */
export function reconcile(billResults) {
  const confirmedLines = [];
  const pendingLines = [];
  for (const bill of billResults) {
    if (bill.state === 'confirmed') {
      confirmedLines.push({ ...bill, postingEligible: true });
    } else {
      pendingLines.push({ ...bill, postingEligible: false });
    }
  }
  return {
    confirmedLines,
    pendingLines,
    totals: {
      confirmedFen: confirmedLines.reduce((s, l) => s + l.fen, 0),
      provisionalFen: pendingLines.reduce((s, l) => s + (l.provisional?.fen ?? 0), 0),
      currency: confirmedLines[0]?.currency ?? pendingLines[0]?.provisional?.currency ?? 'CNY',
    },
  };
}

/**
 * 当新事实（yard 更正 release、registry 更正、换装补件）影响一条已确认行时，
 * 生成冲抵包：原行全额红字 + 按新事实重算的替换行。
 * @param {object} confirmedLine 已确认的原对账行
 * @param {object} newBill 用新事实重算的 billOccupancy 结果（confirmed 或 pending）
 * @param {object} trigger 触发更正的事实描述 {kind, ref, detail}
 */
export function buildReversal(confirmedLine, newBill, trigger) {
  const reversalId = stableId('REV', [confirmedLine.lineId, trigger.kind, trigger.ref]);
  const reversal = {
    reversalId,
    originalLineId: confirmedLine.lineId,
    wagon: confirmedLine.wagon,
    period: confirmedLine.period,
    kind: trigger.kind,
    triggerRef: trigger.ref,
    detail: trigger.detail ?? null,
    originalRange: {
      startRef: confirmedLine.startRef,
      endRef: confirmedLine.endRef,
      rawMinutes: confirmedLine.rawMinutes,
      chargeableMinutes: confirmedLine.chargeableMinutes,
      fen: confirmedLine.fen,
    },
    // 待冲抵范围：原行全额红冲；替换行为新口径，差额即净影响。
    reversalFen: -confirmedLine.fen,
    state: 'to-offset',
    replacement: newBill.state === 'confirmed'
      ? {
          lineId: stableId('LINE', [newBill.wagon, newBill.startRef, newBill.endRef, trigger.ref]),
          startRef: newBill.startRef,
          endRef: newBill.endRef,
          chargeableMinutes: newBill.chargeableMinutes,
          fen: newBill.fen,
          period: newBill.period,
          state: 'replacement-confirmed',
        }
      : {
          state: 'replacement-pending',
          pendingReasons: newBill.pendingReasons,
          provisional: newBill.provisional,
        },
    netFen: newBill.state === 'confirmed' ? newBill.fen - confirmedLine.fen : null,
  };
  return reversal;
}

/**
 * 财务自有压车单回查。
 * @param {Array} ledgerRows 财务台账行 {line, wagon, from_ref, to_ref, charged_minutes, party, period, state}
 * @param {Array} confirmedLines 本系统确认行
 */
export function crossCheckLedger(ledgerRows, confirmedLines) {
  const byWagon = new Map(confirmedLines.map((l) => [l.wagon, l]));
  const disputes = [];
  const matches = [];

  ledgerRows.forEach((row) => {
    const systemLine = byWagon.get(row.wagon);
    if (!systemLine) {
      disputes.push({ ledgerLine: row.line, wagon: row.wagon, code: 'NO_SYSTEM_LINE', message: '台账有行而系统无确认行' });
      return;
    }
    const problems = [];
    if (row.from_ref !== systemLine.startRef) problems.push('from_ref');
    // 台账可能仍引用被替代的旧 release（如 Y2 已被 Y2A 更正）。
    const endRefs = [systemLine.endRef, ...systemLine.evidence.supersededRefs.map((s) => s.ref)];
    if (!endRefs.includes(row.to_ref)) problems.push('to_ref');
    if (row.charged_minutes !== systemLine.chargeableMinutes) problems.push('charged_minutes');
    if (row.period !== systemLine.period) problems.push('period');

    if (problems.length === 0) {
      matches.push({ ledgerLine: row.line, systemLineId: systemLine.lineId, wagon: row.wagon });
    } else {
      disputes.push({
        ledgerLine: row.line,
        wagon: row.wagon,
        code: 'MISMATCH',
        fields: problems,
        ledger: {
          from_ref: row.from_ref,
          to_ref: row.to_ref,
          charged_minutes: row.charged_minutes,
          period: row.period,
        },
        system: {
          startRef: systemLine.startRef,
          endRef: systemLine.endRef,
          chargeableMinutes: systemLine.chargeableMinutes,
          period: systemLine.period,
          supersededRefs: systemLine.evidence.supersededRefs,
        },
      });
    }
  });

  const ledgerWagons = new Set(ledgerRows.map((r) => r.wagon));
  for (const line of confirmedLines) {
    if (!ledgerWagons.has(line.wagon)) {
      disputes.push({ ledgerLine: null, wagon: line.wagon, code: 'MISSING_IN_LEDGER', message: '系统已确认但财务台账缺行' });
    }
  }

  return { matches, disputes };
}
