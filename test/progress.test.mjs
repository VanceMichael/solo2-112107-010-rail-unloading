import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWaybillProgress, buildShiftHandoff } from '../src/domain/progress.mjs';

const lineage = {
  waybill: 'F221', version: 'D2',
  expectedKg: 114000, receivedKg: 97000, outstandingKg: 0,
  missingPages: [{ page: 'train-c', reason: 'PAGE_NOT_PUBLISHED' }],
  warnings: [{ code: 'MISSING_LINK', page: 'train-c' }],
  wagonLinks: [
    { wagon: 'W-32', train: 'Q17', dispatchRef: 'D1', linkStatus: 'linked', attached: true, allocatedKg: 55000, remainingKg: 38000, receivedKg: 38000, events: [] },
    { wagon: 'W-51', train: 'Q18', dispatchRef: null, linkStatus: 'linked', attached: true, allocatedKg: 17000, remainingKg: 17000, receivedKg: 17000, events: [] },
  ],
};

const occ = new Map([
  ['W-32', {
    intervalId: 'O1', startStatus: 'confirmed', start: { ref: 'Y1' },
    endStatus: 'confirmed', end: { ref: 'Y2A' }, pendingReasons: [],
  }],
  ['W-51', {
    intervalId: 'O2', startStatus: 'cargo-on-site', start: { ref: 'G1', party: null },
    endStatus: 'pending', end: null,
    pendingReasons: [
      { code: 'START_PENDING_TAKE', message: '货物已在场，占车起点 take 凭据待补' },
      { code: 'END_PENDING_RELEASE', message: '空车交还 release 未确认' },
    ],
  }],
]);

const segments = new Map([
  ['W-32', [{ ticket: 'V1' }, { ticket: 'V2' }]],
  ['W-51', [{ ticket: 'V4' }]],
]);

test('进度视图：已交还车与待核车阶段区分，缺页保留在视图中', () => {
  const p = buildWaybillProgress(lineage, occ, segments);
  assert.equal(p.wagons[0].stage, 'returned-empty');
  assert.equal(p.wagons[0].unloadSegments.length, 2);
  // W-51 已卸但终点待证，且起点也待证
  assert.equal(p.wagons[1].stage, 'start-pending-evidence');
  assert.deepEqual(p.missingPages, [{ page: 'train-c', reason: 'PAGE_NOT_PUBLISHED' }]);
});

test('班次交接：缺页与待核原因都形成待办，下一班照同一事实办理', () => {
  const p = buildWaybillProgress(lineage, occ, segments);
  const h = buildShiftHandoff(p, 'S-night', '2026-11-27T20:00+08:00');
  assert.deepEqual(h.missingPages, lineage.missingPages);
  assert.ok(h.todos.some((t) => t.reason === 'PAGE_NOT_PUBLISHED'));
  assert.ok(h.todos.some((t) => t.wagon === 'W-51' && t.reason === 'END_PENDING_RELEASE'));
  assert.ok(h.todos.some((t) => t.wagon === 'W-51' && t.reason === 'START_PENDING_TAKE'));
  assert.equal(h.summary.returnedEmpty, 1);
  assert.equal(h.summary.pending, 1);
});
