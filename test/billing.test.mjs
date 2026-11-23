import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOccupancy } from '../src/domain/occupancy.mjs';
import { billOccupancy, normalizeTerms } from '../src/domain/billing.mjs';

const terms = normalizeTerms({
  currency: 'CNY', freeMinutes: 60, fenPerMinute: 200,
  interval: 'take-to-release', party: 'party-during-interval',
});

test('免计 60 分钟，超出按分/分钟计费（W-32 更正后口径）', () => {
  const occ = buildOccupancy('W-32', [
    { ref: 'Y1', action: 'take', time: '2026-11-27T07:20+08:00', party: 'plant' },
    { ref: 'Y2A', action: 'release', time: '2026-11-27T10:50+08:00', party: 'rail', supersedes: 'Y2' },
    { ref: 'Y2', action: 'release', time: '2026-11-27T11:20+08:00', party: 'rail' },
  ]);
  const bill = billOccupancy(occ, terms);
  assert.equal(bill.state, 'confirmed');
  assert.equal(bill.rawMinutes, 210);
  assert.equal(bill.freeMinutes, 60);
  assert.equal(bill.chargeableMinutes, 150);
  assert.equal(bill.fen, 30000); // 150 * 200 分 = 300.00 元
  assert.equal(bill.period, '2026-11');
});

test('W-33：180 分钟占用 -> 120 计费分钟 -> 24000 分', () => {
  const occ = buildOccupancy('W-33', [
    { ref: 'Y3', action: 'take', time: '2026-11-27T09:30+08:00', party: 'plant' },
    { ref: 'Y4', action: 'release', time: '2026-11-27T12:30+08:00', party: 'rail' },
  ]);
  const bill = billOccupancy(occ, terms);
  assert.equal(bill.chargeableMinutes, 120);
  assert.equal(bill.fen, 24000);
  assert.deepEqual(bill.partyCharges.map((p) => [p.party, p.fen]), [['plant', 24000]]);
});

test('占用不足免计区间时收费为 0 但仍出确认行', () => {
  const occ = buildOccupancy('W-6', [
    { ref: 'T', action: 'take', time: '2026-11-27T09:00+08:00', party: 'plant' },
    { ref: 'R', action: 'release', time: '2026-11-27T09:40+08:00', party: 'rail' },
  ]);
  const bill = billOccupancy(occ, terms);
  assert.equal(bill.rawMinutes, 40);
  assert.equal(bill.chargeableMinutes, 0);
  assert.equal(bill.fen, 0);
  assert.equal(bill.state, 'confirmed');
});

test('待核占用只出暂估，不出最终行', () => {
  const occ = buildOccupancy('W-51', [
    { ref: 'Y5', action: 'take', time: '2026-11-27T08:20+08:00', party: 'plant' },
  ], [], [], );
  const bill = billOccupancy(occ, terms, '2026-11-27T12:20+08:00');
  assert.equal(bill.state, 'pending');
  assert.equal(bill.lineId, null);
  assert.equal(bill.provisional.chargeableMinutes, 180); // 240 - 60
  assert.equal(bill.provisional.fen, 36000);
  assert.ok(bill.provisional.note.includes('不得作为最终对账行'));
});

test('责任方中途交接：分段计费且免计只扣一次', () => {
  const occ = buildOccupancy('W-7', [
    { ref: 'T1', action: 'take', time: '2026-11-27T08:00+08:00', party: 'carrier' },
    { ref: 'H1', action: 'handoff', time: '2026-11-27T09:00+08:00', party: 'plant' },
    { ref: 'R1', action: 'release', time: '2026-11-27T11:00+08:00', party: 'rail' },
  ]);
  const bill = billOccupancy(occ, terms);
  assert.equal(bill.rawMinutes, 180);
  assert.equal(bill.freeMinutes, 60);
  assert.equal(bill.chargeableMinutes, 120);
  // 免计在开头 carrier 段（60 分钟）全扣；carrier 段 0 收费，plant 段 120 分钟
  const byParty = Object.fromEntries(bill.partyCharges.map((p) => [p.party, p.fen]));
  assert.equal(byParty.carrier, 0);
  assert.equal(byParty.plant, 24000);
});

test('条款按占用期间生效凭据切换（生效区间外的条款不适用）', () => {
  const staged = normalizeTerms([
    { termId: 'old', effectiveFrom: '2026-10-01T00:00+08:00', effectiveUntil: '2026-11-27T10:00+08:00', freeMinutes: 60, fenPerMinute: 100 },
    { termId: 'new', effectiveFrom: '2026-11-27T10:00+08:00', effectiveUntil: null, freeMinutes: 0, fenPerMinute: 300 },
  ]);
  const occ = buildOccupancy('W-7', [
    { ref: 'T1', action: 'take', time: '2026-11-27T08:00+08:00', party: 'plant' },
    { ref: 'R1', action: 'release', time: '2026-11-27T12:00+08:00', party: 'rail' },
  ]);
  const bill = billOccupancy(occ, staged);
  // 08:00-10:00 旧条款 120 分钟（免 60，60*100=6000）；10:00-12:00 新条款 120 分钟（120*300=36000）
  assert.equal(bill.fen, 42000);
  assert.equal(bill.freeMinutes, 60);
});
