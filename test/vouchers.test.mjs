import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityResolver } from '../src/domain/identity.mjs';
import { mergeWeighVouchers, unloadSegmentsByWagon, receivedKgByWagon } from '../src/domain/vouchers.mjs';
import { parseCsv } from '../src/source/csv.mjs';

const identity = new IdentityResolver([
  { wagon: 'W-32', device: 'S-42', line: 'east', from_time: '2026-11-01T00:00+08:00', until: null },
  { wagon: 'W-33', device: 'S-43', line: 'east', from_time: '2026-11-01T00:00+08:00', until: null },
  { wagon: 'W-51', device: 'S-51', line: 'east', from_time: '2026-11-01T00:00+08:00', until: null },
]);

const csv = [
  'ticket,line,device,time,net_kg,side',
  'V1,east,S-42,2026-11-27T08:00+08:00,26000,unload',
  'V2,east,S-42,2026-11-27T08:45+08:00,12000,unload',
  'V3,east,S-43,2026-11-27T10:00+08:00,42000,unload',
  'V4,east,S-51,2026-11-27T09:00+08:00,17000,unload',
  'V4,east,S-51,2026-11-27T09:00+08:00,17000,unload',
  'V5,east,S-42,2026-11-27T09:30+08:00,5000,unload',
].join('\n');

test('重复磅单按同一计量凭据归并，重量不重复计', () => {
  const { vouchers, warnings } = mergeWeighVouchers(parseCsv(csv), identity);
  assert.equal(vouchers.size, 5);
  const v4 = vouchers.get('V4');
  assert.equal(v4.duplicateCount, 2);
  assert.equal(v4.netKg, 17000);
  assert.equal(v4.wagon, 'W-51');
  assert.equal(warnings.length, 0);
});

test('手工补登沿用计量号时归并并保留分段与告警', () => {
  const manual = csv + '\nV5,east,S-42,2026-11-27T10:10+08:00,3000,unload';
  const { vouchers, warnings } = mergeWeighVouchers(parseCsv(manual), identity);
  const v5 = vouchers.get('V5');
  assert.equal(v5.supplements.length, 1);
  assert.equal(warnings.some((w) => w.code === 'VOUCHER_SUPPLEMENT' && w.ticket === 'V5'), true);
});

test('一车两次卸煤保留分段，实收为分段之和', () => {
  const { vouchers } = mergeWeighVouchers(parseCsv(csv), identity);
  const segments = unloadSegmentsByWagon(vouchers);
  const w32 = segments.get('W-32');
  assert.deepEqual(w32.map((s) => s.ticket), ['V1', 'V2', 'V5']);
  const totals = receivedKgByWagon(segments);
  assert.equal(totals.get('W-32'), 43000); // 26000+12000+5000
  assert.equal(totals.get('W-33'), 42000);
  assert.equal(totals.get('W-51'), 17000);
});
