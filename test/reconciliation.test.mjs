import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, buildReversal, crossCheckLedger } from '../src/domain/reconciliation.mjs';

const confirmedW32 = {
  lineId: 'LINE-old', wagon: 'W-32', state: 'confirmed', period: '2026-11',
  startRef: 'Y1', endRef: 'Y2', rawMinutes: 240, freeMinutes: 60, chargeableMinutes: 180,
  fen: 36000, currency: 'CNY',
  evidence: { start: { ref: 'Y1' }, end: { ref: 'Y2' }, supersededRefs: [] },
};
const confirmedW33 = {
  lineId: 'LINE-w33', wagon: 'W-33', state: 'confirmed', period: '2026-11',
  startRef: 'Y3', endRef: 'Y4', rawMinutes: 180, freeMinutes: 60, chargeableMinutes: 120,
  fen: 24000, currency: 'CNY',
  evidence: { start: { ref: 'Y3' }, end: { ref: 'Y4' }, supersededRefs: [] },
};
const pendingW51 = {
  lineId: null, wagon: 'W-51', state: 'pending', postingEligible: false,
  pendingReasons: [{ code: 'END_PENDING_RELEASE' }],
  provisional: { fen: 36000 },
};

test('逐车独立确认：同运单有待核车不挂起证据完整车', () => {
  const r = reconcile([confirmedW32, confirmedW33, pendingW51]);
  assert.equal(r.confirmedLines.length, 2);
  assert.equal(r.pendingLines.length, 1);
  assert.equal(r.pendingLines[0].postingEligible, false);
  assert.equal(r.totals.confirmedFen, 60000);
  assert.equal(r.totals.provisionalFen, 36000);
});

test('更正触及已确认行：红冲原区间并给出替换行与待冲抵范围', () => {
  const freshBill = {
    state: 'confirmed', wagon: 'W-32', lineId: 'LINE-new',
    startRef: 'Y1', endRef: 'Y2A', rawMinutes: 210, chargeableMinutes: 150, fen: 30000, period: '2026-11',
    evidence: { supersededRefs: [{ ref: 'Y2', supersededBy: 'Y2A' }] },
  };
  const rev = buildReversal(confirmedW32, freshBill, {
    kind: 'yard-release-supersede', ref: 'Y2A', detail: { oldEndRef: 'Y2', newEndRef: 'Y2A' },
  });
  assert.equal(rev.originalLineId, 'LINE-old');
  assert.equal(rev.reversalFen, -36000);
  assert.equal(rev.state, 'to-offset');
  assert.equal(rev.replacement.fen, 30000);
  assert.equal(rev.replacement.endRef, 'Y2A');
  assert.equal(rev.netFen, -6000); // 净退 60 元
  assert.deepEqual(rev.originalRange, {
    startRef: 'Y1', endRef: 'Y2', rawMinutes: 240, chargeableMinutes: 180, fen: 36000,
  });
});

test('财务台账回查：引用被替代旧 release 且分钟数不符时产生争议并保留原记录', () => {
  const systemLine = {
    ...confirmedW32,
    endRef: 'Y2A',
    chargeableMinutes: 150,
    evidence: { start: { ref: 'Y1' }, end: { ref: 'Y2A' }, supersededRefs: [{ ref: 'Y2', supersededBy: 'Y2A' }] },
  };
  const ledger = [
    { line: 'L1', wagon: 'W-32', from_ref: 'Y1', to_ref: 'Y2', charged_minutes: 180, party: 'plant', period: '2026-11', state: 'confirmed' },
    { line: 'L2', wagon: 'W-33', from_ref: 'Y3', to_ref: 'Y4', charged_minutes: 120, party: 'plant', period: '2026-11', state: 'confirmed' },
  ];
  const result = crossCheckLedger(ledger, [systemLine, confirmedW33]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].ledgerLine, 'L2');
  const dispute = result.disputes.find((d) => d.wagon === 'W-32');
  assert.ok(dispute.fields.includes('charged_minutes'));
  // Y2 虽在被替代清单内，凭据可对上；差异聚焦在分钟数
  assert.ok(!dispute.fields.includes('to_ref'));
  assert.equal(dispute.system.supersededRefs[0].ref, 'Y2');
});
