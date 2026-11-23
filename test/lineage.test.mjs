import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLineage } from '../src/domain/lineage.mjs';

const indexD2 = { waybill: 'F221', version: 'D2', pages: ['train-a', 'train-b', 'train-c'] };
const pages = new Map([
  ['train-a', [{ ref: 'D1', waybill: 'F221', train: 'Q17', wagon: 'W-32', coalKg: 55000, depart: '2026-11-27T02:20+08:00' }]],
  ['train-b', [{ ref: 'D2', waybill: 'F221', train: 'Q17', wagon: 'W-33', coalKg: 42000, depart: '2026-11-27T02:20+08:00' }]],
  ['train-c', null], // 目录声明但页未发布（404 缺联）
]);
const changes = [
  { ref: 'C1', waybill: 'F221', type: 'reform', train: 'Q18', predecessor: 'Q17', from_wagon: 'W-33', to_wagon: 'W-33', kg: 42000, time: '2026-11-27T04:40+08:00' },
  { ref: 'C2', waybill: 'F221', type: 'transload', train: 'Q18', predecessor: 'Q17', from_wagon: 'W-32', to_wagon: 'W-51', kg: 17000, time: '2026-11-27T05:30+08:00' },
];

test('缺页登记为缺联且不产生脱运单判断', () => {
  const lineage = buildLineage(indexD2, pages, changes, new Map());
  assert.equal(lineage.missingPages[0].page, 'train-c');
  assert.ok(lineage.warnings.some((w) => w.code === 'MISSING_LINK'));
  // 缺页本身不凭空生成车联；后续换装凭据出现 W-51 时再接上
  const w51 = lineage.wagonLinks.find((l) => l.wagon === 'W-51');
  assert.equal(w51.attached, true);
  assert.equal(w51.linkStatus, 'linked');
});

test('换编（reform）不换车不脱联，只承接新车列', () => {
  const lineage = buildLineage(indexD2, pages, changes, new Map());
  const w33 = lineage.wagonLinks.find((l) => l.wagon === 'W-33');
  assert.equal(w33.train, 'Q18');
  assert.equal(w33.attached, true);
  assert.equal(w33.allocatedKg, 42000);
  assert.ok(w33.events.some((e) => e.kind === 'reform'));
});

test('换装货物跟接收车走，旧车保留剩余量且运单不变', () => {
  // 模拟 confirmed：train-c 页发布，D3 是换装后清册事实（货量与 C2 转入量一致）
  const pagesWithC = new Map(pages);
  pagesWithC.set('train-c', [{
    ref: 'D3', waybill: 'F221', train: 'Q18', wagon: 'W-51', coalKg: 17000,
    depart: '2026-11-27T05:30+08:00',
  }]);
  const received = new Map([['W-32', 38000], ['W-51', 17000]]);
  const lineage = buildLineage(indexD2, pagesWithC, changes, received);
  const w32 = lineage.wagonLinks.find((l) => l.wagon === 'W-32');
  const w51 = lineage.wagonLinks.find((l) => l.wagon === 'W-51');
  assert.equal(w32.allocatedKg, 55000);
  assert.equal(w32.remainingKg, 38000); // 55000 - 17000 留在原车
  assert.equal(w51.allocatedKg, 17000); // D3 与 C2 同量，不重复计
  assert.equal(w51.remainingKg, 17000);
  assert.ok(w32.events.some((e) => e.kind === 'transload-out'));
  assert.ok(w51.events.some((e) => e.kind === 'transload-in'));
  assert.ok(lineage.warnings.some((w) => w.code === 'TRANSLOAD_PAGE_FACT'));
  // 车联分配总量含换装转出/转入两侧陈列：55000 + 42000 + 17000 = 114000
  assert.equal(lineage.expectedKg, 114000);
  // 原发运量守恒口径（转出量只计一次）
  assert.equal(lineage.originalDispatchedKg, 97000);
  assert.equal(lineage.receivedKg, 55000);
  assert.equal(lineage.outstandingKg, 42000);
});

test('换装接收车的普通新发车页（货量不同于转入量）仍正常计分配', () => {
  const pagesWithC = new Map(pages);
  pagesWithC.set('train-c', [{
    ref: 'D3', waybill: 'F221', train: 'Q18', wagon: 'W-51', coalKg: 20000,
    depart: '2026-11-27T05:30+08:00',
  }]);
  const lineage = buildLineage(indexD2, pagesWithC, changes, new Map());
  const w51 = lineage.wagonLinks.find((l) => l.wagon === 'W-51');
  assert.equal(w51.allocatedKg, 17000 + 20000); // 换装 17000 + 新发 20000
});

test('显式 detach 才允许脱联', () => {
  const withDetach = [...changes, { ref: 'C9', waybill: 'F221', type: 'detach', from_wagon: 'W-33', time: '2026-11-27T06:00+08:00' }];
  const lineage = buildLineage(indexD2, pages, withDetach, new Map());
  const w33 = lineage.wagonLinks.find((l) => l.wagon === 'W-33');
  assert.equal(w33.attached, false);
});
