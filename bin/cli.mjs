#!/usr/bin/env node
// 命令行入口。所有输出为 JSON，便于脚本化与人工核对。
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpSource, FileSource, PHASES } from '../src/source/client.mjs';
import { JsonEventStore } from '../src/storage/store.mjs';
import { ingestPhase, recordGates } from '../src/app/ingest.mjs';
import { rebuild, confirmEligible, processCorrections, shiftHandoff } from '../src/app/service.mjs';
import { PortalBook } from '../src/app/portal.mjs';
import { fenToYuan } from '../src/domain/util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function buildSource(args) {
  const mode = args.mode ?? 'file';
  if (mode === 'http') {
    return new HttpSource(args.base ?? process.env.SOURCE_URL ?? 'http://127.0.0.1:4173');
  }
  const wireDir = resolve(root, args.wire ?? 'wire');
  const manifest = JSON.parse(await readFile(resolve(root, args.manifest ?? 'wire.json'), 'utf8'));
  return new FileSource(wireDir, manifest);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const storePath = resolve(root, args.store ?? 'data/events.json');
  const store = new JsonEventStore(storePath);
  await store.load();

  switch (command) {
    case 'ingest': {
      const phase = args.phase;
      if (!PHASES.includes(phase)) throw new Error(`--phase 必须是 ${PHASES.join('|')}`);
      const source = await buildSource(args);
      print(await ingestPhase(source, store, phase));
      break;
    }

    case 'gate': {
      // --file 指向门禁 JSON 数组（允许晚补录）
      const rows = JSON.parse(await readFile(resolve(args.file), 'utf8'));
      print(recordGates(store, rows, args.file));
      await store.persist();
      break;
    }

    case 'progress': {
      const { ready, reason, models } = rebuild(store);
      if (!ready) return print({ ready, reason });
      print(models.progress);
      break;
    }

    case 'handoff': {
      print(shiftHandoff(store, args.shift ?? `S-${Date.now()}`, args.at ?? new Date().toISOString()));
      break;
    }

    case 'bills': {
      const { ready, reason, models } = rebuild(store, { asOf: args.asof ?? null });
      if (!ready) return print({ ready, reason });
      print(models.reconciliation);
      break;
    }

    case 'confirm': {
      const ids = confirmEligible(store);
      await store.persist();
      print({ confirmed: ids, store: storePath });
      break;
    }

    case 'correct': {
      const reversals = processCorrections(store);
      await store.persist();
      print(reversals);
      break;
    }

    case 'ledger-check': {
      const { ready, reason, models } = rebuild(store);
      if (!ready) return print({ ready, reason });
      print(models.ledgerCheck);
      break;
    }

    case 'post': {
      const source = await buildSource(args);
      if (!(source instanceof HttpSource)) throw new Error('post 需要 --mode http');
      const { models } = rebuild(store);
      const book = new PortalBook(source, store, args.phase ?? 'confirmed');
      const receipts = [];
      for (const line of models.reconciliation.confirmedLines) {
        receipts.push(await book.postLine(line));
      }
      print(receipts);
      break;
    }

    case 'post-credits': {
      const source = await buildSource(args);
      if (!(source instanceof HttpSource)) throw new Error('post-credits 需要 --mode http');
      const book = new PortalBook(source, store, args.phase ?? 'confirmed');
      const receipts = [];
      for (const reversal of store.state.reversals.filter((r) => r.state === 'to-offset')) {
        receipts.push(await book.postCredit(reversal));
      }
      print(receipts);
      break;
    }

    case 'summary': {
      const { ready, reason, models } = rebuild(store);
      if (!ready) return print({ ready, reason });
      const r = models.reconciliation;
      print({
        waybill: models.lineage.waybill,
        expectedKg: models.lineage.expectedKg,
        receivedKg: models.lineage.receivedKg,
        confirmedLines: r.confirmedLines.length,
        pendingLines: r.pendingLines.length,
        confirmedAmount: { fen: r.totals.confirmedFen, yuan: fenToYuan(r.totals.confirmedFen), currency: r.totals.currency },
        provisionalAmount: { fen: r.totals.provisionalFen, yuan: fenToYuan(r.totals.provisionalFen) },
        ledgerDisputes: models.ledgerCheck.disputes.length,
        reversals: store.state.reversals.length,
      });
      break;
    }

    default:
      process.stdout.write([
        '用法: node cli.mjs <command> [options]',
        '命令:',
        '  ingest --phase <opening|interim|confirmed> [--mode file|http] [--base URL]',
        '  gate --file gates.json        手工补录门禁（允许晚写入）',
        '  progress                      调度员运单进度（已收量/缺车联/占用状态）',
        '  handoff [--shift ID] [--at ISO]  班次交接快照',
        '  bills [--asof ISO]            压车计费（待核车只出暂估）',
        '  confirm                       确认证据完整车辆的对账行',
        '  correct                       识别更正并生成待冲抵包',
        '  ledger-check                  财务压车单回查争议',
        '  post --mode http              向门户上报确认行（幂等）',
        '  post-credits --mode http      上报冲抵（幂等）',
        '  summary                       一页式汇总',
      ].join('\n') + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`${err.name ?? 'Error'}: ${err.message}\n`);
  if (process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
