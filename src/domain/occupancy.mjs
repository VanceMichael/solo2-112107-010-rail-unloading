// 车辆占用区间（压车计时的事实层）。
// 合同口径 terms.interval = take-to-release：占用自厂内 take 起，至空车交还 release 止。
// 关键约束：
//  - 最后一次卸货不能代替空车交还（release 是唯一终点凭据）；
//  - 门禁晚写入时要区分“货物已在场”与“占车起点待证”：
//      有 take 凭据      -> startStatus = confirmed；
//      无 take 但有门禁且货物已在场 -> startStatus = cargo-on-site（起点待证，按门禁时间暂记）；
//      无 take 无门禁     -> startStatus = missing；
//  - release 带 supersedes 时以新单为准，旧单进入 supersededRefs 可追溯；
//  - 终点缺失只报“待核”，绝不产出最终对账行。
import { toEpoch, minutesBetween, sortBy, stableId } from './util.mjs';

/**
 * 处理单部车的占用事实。
 * @param {string} wagon
 * @param {object[]} yardRows 该车的 take/release 记录（可含被替代的旧 release）
 * @param {object[]} gateRows 该车的门禁记录（可选，允许晚补）
 * @param {object[]} unloadSegments 该车分段卸煤记录（仅用于判定货物是否已在场及证据陈列）
 */
export function buildOccupancy(wagon, yardRows, gateRows = [], unloadSegments = []) {
  const takeRows = sortBy(yardRows.filter((y) => y.action === 'take'), (y) => toEpoch(y.time));
  const allReleaseRows = sortBy(yardRows.filter((y) => y.action === 'release'), (y) => toEpoch(y.time));

  // 替代链：Y2A.supersedes = Y2。被替代的 release 不参与计时，但保留为追溯凭据。
  const supersededRefs = new Set();
  allReleaseRows.forEach((r) => {
    if (r.supersedes) supersededRefs.add(r.supersedes);
  });
  const activeReleases = allReleaseRows.filter((r) => !supersededRefs.has(r.ref));
  const supersededRows = allReleaseRows.filter((r) => supersededRefs.has(r.ref));

  const gates = sortBy(gateRows, (g) => toEpoch(g.time));
  const firstGate = gates[0] ?? null;
  const firstTake = takeRows[0] ?? null;
  const firstUnload = unloadSegments[0] ?? null;
  const cargoOnSite = Boolean(firstUnload) || Boolean(firstGate?.cargoOnSite);

  let start = null;
  let startStatus = 'missing';
  const startEvidence = [];

  if (firstTake) {
    start = {
      time: firstTake.time,
      ref: firstTake.ref,
      party: firstTake.party,
      source: 'yard',
    };
    startStatus = 'confirmed';
    startEvidence.push({ kind: 'yard-take', ref: firstTake.ref, time: firstTake.time, party: firstTake.party });
  } else if (firstGate && cargoOnSite) {
    // 门禁晚写入：货物已在场，但占车起点（take）凭据缺失，只能暂记待证。
    start = {
      time: firstGate.time,
      ref: firstGate.ref,
      party: null, // 责任方随 take 凭据而定，缺 take 时不得臆断
      source: 'gate',
    };
    startStatus = 'cargo-on-site';
    startEvidence.push({ kind: 'gate', ref: firstGate.ref, time: firstGate.time, cargoOnSite: true });
  } else {
    startStatus = cargoOnSite ? 'cargo-on-site' : 'missing';
    if (firstGate) startEvidence.push({ kind: 'gate', ref: firstGate.ref, time: firstGate.time, cargoOnSite: Boolean(firstGate.cargoOnSite) });
  }

  // 终点：一次连续占用取最早一条有效 release（被替代的旧单不算）。
  const release = activeReleases[0] ?? null;
  const end = release
    ? { time: release.time, ref: release.ref, party: release.party, source: 'yard' }
    : null;
  const endStatus = release ? 'confirmed' : 'pending';

  // 占用期间的责任交接序列（take 与后续 handoff 都可能改变计费责任方）。
  const handovers = takeRows.map((t) => ({
    kind: 'take',
    ref: t.ref,
    time: t.time,
    party: t.party,
  }));
  yardRows
    .filter((y) => y.action === 'handoff')
    .forEach((h) => handovers.push({ kind: 'handoff', ref: h.ref, time: h.time, party: h.party }));
  handovers.sort((a, b) => toEpoch(a.time) - toEpoch(b.time));

  const intervalId = stableId('OCC', [wagon, start?.time ?? 'no-start', end?.time ?? 'open']);
  const confirmed = startStatus === 'confirmed' && endStatus === 'confirmed';

  const result = {
    intervalId,
    waybillRef: wagon,
    wagon,
    start,
    startStatus,
    startEvidence,
    end,
    endStatus,
    endEvidence: release
      ? [{ kind: 'yard-release', ref: release.ref, time: release.time, party: release.party }]
      : [],
    handovers,
    supersededRefs: supersededRows.map((r) => ({
      ref: r.ref,
      time: r.time,
      supersededBy: allReleaseRows.find((n) => n.supersedes === r.ref)?.ref ?? null,
    })),
    gateEvidence: gates.map((g) => ({ ref: g.ref, time: g.time, cargoOnSite: Boolean(g.cargoOnSite) })),
    cargoOnSite,
    confirmed,
    pendingReasons: [],
  };

  if (!confirmed) {
    if (startStatus === 'cargo-on-site') {
      result.pendingReasons.push({ code: 'START_PENDING_TAKE', message: '货物已在场，占车起点 take 凭据待补' });
    }
    if (startStatus === 'missing') {
      result.pendingReasons.push({ code: 'START_MISSING', message: '缺少 take 与门禁凭据，占车起点无法确定' });
    }
    if (endStatus === 'pending') {
      result.pendingReasons.push({ code: 'END_PENDING_RELEASE', message: '空车交还 release 未确认，卸货记录不能代替终点' });
    }
    if (start) {
      // 仅记录截至当前凭据的已观察分钟（终点仍待核，不参与最终计费）。
      const observed = [firstGate?.time, ...gates.map((g) => g.time)]
        .filter(Boolean)
        .map(toEpoch);
      const startMs = toEpoch(start.time);
      const throughMs = observed.length ? Math.max(startMs, ...observed) : startMs;
      if (throughMs > startMs) {
        result.elapsedMinutesToNow = Math.floor((throughMs - startMs) / 60000);
      }
    }
  } else {
    result.totalMinutes = minutesBetween(start.time, end.time);
  }

  return result;
}
