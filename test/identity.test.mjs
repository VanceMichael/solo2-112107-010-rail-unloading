import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityResolver, IdentityError } from '../src/domain/identity.mjs';

const rows = [
  { wagon: 'W-1', device: 'S-1', line: 'east', from_time: '2026-11-01T00:00+08:00', until: '2026-11-15T00:00+08:00' },
  { wagon: 'W-1', device: 'S-9', line: 'east', from_time: '2026-11-15T00:00+08:00', until: null },
  { wagon: 'W-1', device: 'S-2', line: 'west', from_time: '2026-11-01T00:00+08:00', until: null },
  { wagon: 'W-2', device: 'S-3', line: 'east', from_time: '2026-11-01T00:00+08:00', until: null },
];
const resolver = new IdentityResolver(rows);

test('按线别与生效窗口解析车号/设备号', () => {
  assert.equal(resolver.resolveWagon('S-1', 'east', '2026-11-10T08:00+08:00'), 'W-1');
  // 11-15 后 east 线设备更换
  assert.equal(resolver.resolveWagon('S-9', 'east', '2026-11-20T08:00+08:00'), 'W-1');
  assert.equal(resolver.resolveDevice('W-1', 'west', '2026-11-20T08:00+08:00'), 'S-2');
});

test('窗口边界：until 为排他边界，失效后不可再用旧对应', () => {
  assert.throws(
    () => resolver.resolveWagon('S-1', 'east', '2026-11-15T00:00+08:00'),
    (err) => err instanceof IdentityError && err.code === 'IDENTITY_NOT_FOUND',
  );
});

test('禁止跨线别套用设备号', () => {
  // S-2 只在 west 线有效
  assert.throws(
    () => resolver.resolveWagon('S-2', 'east', '2026-11-10T08:00+08:00'),
    (err) => err.code === 'IDENTITY_NOT_FOUND',
  );
});

test('无对应时抛出带上下文的错误', () => {
  assert.throws(
    () => resolver.resolveWagon('S-X', 'east', '2026-11-10T08:00+08:00'),
    (err) => err.code === 'IDENTITY_NOT_FOUND' && err.details.device === 'S-X',
  );
});
