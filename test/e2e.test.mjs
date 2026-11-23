import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { FileSource } from '../src/source/client.mjs';
import { JsonEventStore } from '../src/storage/store.mjs';
import { ingestPhase, recordGates } from '../src/app/ingest.mjs';
import { rebuild, confirmEligible, processCorrections, shiftHandoff } from '../src/app/service.mjs';

const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(root, 'wire.json'), 'utf8'));

async function freshStore() {
  const dir = join(tmpdir(), `rail-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const store = new JsonEventStore(join(dir, 'events.json'));
  await store.load();
  return { dir, store };
}

test('端到端：opening 缺页缺磅单 -> interim 缺联不脱单 -> confirmed 完整确认与冲抵', async (t) => {
  const { dir, store } = await freshStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = new FileSource(join(root, 'wire'), manifest);

  // ---------- opening ----------
  const opening = await ingestPhase(source, store, 'opening');
  assert.deepEqual(opening.missing.map((m) => m.resource), ['train-c']);
  const afterOpening = rebuild(store);
  assert.equal(afterOpening.ready, true);
  const op = afterOpening.models;
  assert.equal(op.lineage.wagonLinks.length, 2); // 只有 D1/D2 两车
  assert.equal(op.lineage.expectedKg, 97000);
  // opening 口径：Y2 11:20，占用 240 分钟，免 60 -> 180
  const w32Opening = op.bills.find((b) => b.wagon === 'W-32');
  assert.equal(w32Opening.chargeableMinutes, 180);
  assert.equal(w32Opening.fen, 36000);
  // opening 台账 L1（W-32 旧口径）与系统一致；W-33 财务尚未建行，回查应报缺行
  assert.equal(op.ledgerCheck.matches.length, 1);
  assert.equal(op.ledgerCheck.matches[0].ledgerLine, 'L1');
  assert.equal(op.ledgerCheck.disputes.length, 1);
  assert.deepEqual(op.ledgerCheck.disputes[0], {
    ledgerLine: null, wagon: 'W-33', code: 'MISSING_IN_LEDGER',
    message: '系统已确认但财务台账缺行',
  });

  // ---------- interim：目录 D2 声明 train-c，但页未发布（404 缺联） ----------
  const interim = await ingestPhase(source, store, 'interim');
  assert.ok(interim.missing.some((m) => m.resource === 'train-c'));
  const im = rebuild(store).models;
  // 换装凭据 C2 已发布：W-51 经 transload-in 接联，attached 必须为 true（缺页不等于脱单）
  const w51 = im.lineage.wagonLinks.find((l) => l.wagon === 'W-51');
  assert.ok(w51, '换装凭据出现后 W-51 应已接联');
  assert.equal(w51.attached, true);
  assert.equal(im.lineage.missingPages.some((p) => p.page === 'train-c'), true);
  // 重复磅单 V4 归并，W-51 实收 17000，只算一次
  assert.equal(im.segmentsByWagon.get('W-51').length, 1);
  assert.equal(im.vouchers.get('V4').duplicateCount, 2);
  // W-51 只有 take 没有 release -> 待核，无最终行
  const w51Bill = im.bills.find((b) => b.wagon === 'W-51');
  assert.equal(w51Bill.state, 'pending');
  assert.equal(w51Bill.lineId, null);
  assert.ok(w51Bill.pendingReasons.some((r) => r.code === 'END_PENDING_RELEASE'));
  // W-32/W-33 证据完整，可独立确认，不被 W-51 挂起
  assert.deepEqual(im.reconciliation.confirmedLines.map((l) => l.wagon).sort(), ['W-32', 'W-33']);

  // 调度员进度：已收量与还缺车联
  assert.equal(im.progress.receivedKg, 38000 + 42000 + 17000);
  assert.equal(im.progress.outstandingKg, 0);
  const handoff = shiftHandoff(store, 'S-night', '2026-11-27T20:00+08:00');
  assert.ok(handoff.todos.some((todo) => todo.wagon === 'W-51' && todo.reason === 'END_PENDING_RELEASE'));

  // 月中按 interim 口径冻结确认行（此时 W-32 终点仍是旧 release Y2）
  const interimConfirmedIds = confirmEligible(store);
  assert.equal(interimConfirmedIds.length, 2);
  await store.persist();

  // ---------- confirmed：train-c 发布、Y2A 更正 Y2 ----------
  await ingestPhase(source, store, 'confirmed');
  const cm = rebuild(store).models;
  const w32Final = cm.bills.find((b) => b.wagon === 'W-32');
  assert.equal(w32Final.endRef, 'Y2A');
  assert.equal(w32Final.chargeableMinutes, 150);
  assert.equal(w32Final.fen, 30000);
  const w33Final = cm.bills.find((b) => b.wagon === 'W-33');
  assert.equal(w33Final.chargeableMinutes, 120);
  assert.equal(w33Final.fen, 24000);
  // W-51 仍无 release，继续待核
  assert.equal(cm.bills.find((b) => b.wagon === 'W-51').state, 'pending');
  // 分段卸煤：W-32 两条 V1/V2 都在
  assert.deepEqual(cm.segmentsByWagon.get('W-32').map((s) => s.ticket), ['V1', 'V2']);
  // D3 换装后清册不重复计分配：原发运量守恒为 97000
  assert.equal(cm.lineage.originalDispatchedKg, 97000);
  assert.equal(cm.lineage.expectedKg, 114000);

  // 财务台账 L1 仍是旧口径（Y2/180 分钟）-> 争议可对上原记录
  const dispute = cm.ledgerCheck.disputes.find((d) => d.wagon === 'W-32');
  assert.ok(dispute);
  assert.equal(dispute.ledgerLine, 'L1');
  assert.deepEqual(dispute.fields, ['charged_minutes']);

  // 更正触及已确认行 -> 可追溯的待冲抵包
  const reversals = processCorrections(store);
  const w32Reversal = reversals.find((r) => r.wagon === 'W-32');
  assert.ok(w32Reversal, 'Y2A 更正触及 W-32 已确认行，必须生成冲抵');
  assert.equal(w32Reversal.originalRange.endRef, 'Y2');
  assert.equal(w32Reversal.originalRange.chargeableMinutes, 180);
  assert.equal(w32Reversal.reversalFen, -36000);
  assert.equal(w32Reversal.replacement.endRef, 'Y2A');
  assert.equal(w32Reversal.replacement.fen, 30000);
  assert.equal(w32Reversal.netFen, -6000);
  assert.equal(w32Reversal.state, 'to-offset');
  // W-33 口径未变，不产生冲抵
  assert.equal(reversals.some((r) => r.wagon === 'W-33'), false);

  // 持久化后重放结果一致（可复算）
  await store.persist();
  const reopened = new JsonEventStore(join(dir, 'events.json'));
  await reopened.load();
  const again = rebuild(reopened).models;
  assert.equal(again.bills.find((b) => b.wagon === 'W-32').fen, 30000);
  assert.equal(reopened.state.reversals.length, 1);
  assert.equal(reopened.state.confirmations.length, 2);
});

test('门禁晚写入：货物已在场但 take 待证时不得出最终行', async (t) => {
  const { dir, store } = await freshStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = new FileSource(join(root, 'wire'), manifest);
  await ingestPhase(source, store, 'confirmed');

  // 模拟 take 凭据尚未送达：从事件存储中移除 W-51 的 Y5（原始事件仍可追溯，这里仅构造待证状态）
  store.state.events = store.state.events.filter((e) => {
    if (e.source !== 'yard') return true;
    return !e.payload.some((y) => y.wagon === 'W-51' && y.action === 'take');
  });
  // 晚写入的门禁：过磅（V4，货物在场）已存在，门禁后补，take 仍缺
  const gateFile = join(dir, 'gates.json');
  await writeFile(gateFile, JSON.stringify([
    { ref: 'G51', wagon: 'W-51', time: '2026-11-27T08:50+08:00', cargoOnSite: true },
  ]));
  recordGates(store, JSON.parse(await readFile(gateFile, 'utf8')), gateFile);

  const models = rebuild(store).models;
  const w51 = models.occupancyByWagon.get('W-51');
  assert.equal(w51.startStatus, 'cargo-on-site');
  assert.equal(w51.start.party, null);
  assert.equal(w51.cargoOnSite, true);
  const bill = models.bills.find((b) => b.wagon === 'W-51');
  assert.equal(bill.state, 'pending');
  assert.equal(bill.lineId, null);
  assert.ok(bill.pendingReasons.some((r) => r.code === 'START_PENDING_TAKE'));
});
