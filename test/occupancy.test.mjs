import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOccupancy } from '../src/domain/occupancy.mjs';

test('完整 take-release 给出确认占用与总分钟', () => {
  const occ = buildOccupancy('W-33', [
    { ref: 'Y3', wagon: 'W-33', action: 'take', time: '2026-11-27T09:30+08:00', party: 'plant' },
    { ref: 'Y4', wagon: 'W-33', action: 'release', time: '2026-11-27T12:30+08:00', party: 'rail' },
  ], [], []);
  assert.equal(occ.confirmed, true);
  assert.equal(occ.startStatus, 'confirmed');
  assert.equal(occ.endStatus, 'confirmed');
  assert.equal(occ.totalMinutes, 180);
  assert.equal(occ.start.party, 'plant');
});

test('release 被新单 supersedes 时以新单为准且保留追溯', () => {
  const occ = buildOccupancy('W-32', [
    { ref: 'Y1', wagon: 'W-32', action: 'take', time: '2026-11-27T07:20+08:00', party: 'plant' },
    { ref: 'Y2', wagon: 'W-32', action: 'release', time: '2026-11-27T11:20+08:00', party: 'rail' },
    { ref: 'Y2A', wagon: 'W-32', action: 'release', time: '2026-11-27T10:50+08:00', party: 'rail', supersedes: 'Y2' },
  ], [], []);
  assert.equal(occ.end.ref, 'Y2A');
  assert.equal(occ.totalMinutes, 210); // 07:20 -> 10:50
  assert.deepEqual(occ.supersededRefs.map((s) => s.ref), ['Y2']);
  assert.equal(occ.supersededRefs[0].supersededBy, 'Y2A');
});

test('缺 release（最后卸货不能代替终点）只报待核', () => {
  const occ = buildOccupancy('W-51', [
    { ref: 'Y5', wagon: 'W-51', action: 'take', time: '2026-11-27T08:20+08:00', party: 'plant' },
  ], [], [{ ticket: 'V4', time: '2026-11-27T09:00+08:00', netKg: 17000 }]);
  assert.equal(occ.confirmed, false);
  assert.equal(occ.endStatus, 'pending');
  assert.ok(occ.pendingReasons.some((r) => r.code === 'END_PENDING_RELEASE'));
});

test('门禁晚写入且货物已在场：起点待证，责任方不臆断', () => {
  const occ = buildOccupancy('W-9', [], [
    { ref: 'G1', wagon: 'W-9', time: '2026-11-27T06:00+08:00', cargoOnSite: true },
  ], [{ ticket: 'VX', time: '2026-11-27T06:30+08:00', netKg: 1000 }]);
  assert.equal(occ.startStatus, 'cargo-on-site');
  assert.equal(occ.start.source, 'gate');
  assert.equal(occ.start.party, null);
  assert.ok(occ.pendingReasons.some((r) => r.code === 'START_PENDING_TAKE'));
  assert.equal(occ.confirmed, false);
});

test('无 take 无门禁：起点缺失', () => {
  const occ = buildOccupancy('W-8', [], [], []);
  assert.equal(occ.startStatus, 'missing');
  assert.ok(occ.pendingReasons.some((r) => r.code === 'START_MISSING'));
});

test('责任交接（handoff）进入占用责任时间轴', () => {
  const occ = buildOccupancy('W-7', [
    { ref: 'T1', wagon: 'W-7', action: 'take', time: '2026-11-27T08:00+08:00', party: 'carrier' },
    { ref: 'H1', wagon: 'W-7', action: 'handoff', time: '2026-11-27T09:00+08:00', party: 'plant' },
    { ref: 'R1', wagon: 'W-7', action: 'release', time: '2026-11-27T11:00+08:00', party: 'rail' },
  ], [], []);
  assert.equal(occ.handovers.length, 2);
  assert.equal(occ.handovers[1].party, 'plant');
  assert.equal(occ.totalMinutes, 180);
});
