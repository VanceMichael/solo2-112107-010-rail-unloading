// 压车计费：把占用区间按“车辆占用期间有效的合同凭据”切分，套用免计分钟与分/分钟单价。
// 规则：
//  - 合同条款（terms）带生效区间；只允许使用占用期间内有效的凭据；
//  - 计费责任方按占用期间内的责任交接（handovers/take 的 party）分段；
//  - 免计区间（freeMinutes）只在每次连续占用的开头扣一次；跨条款/跨责任方不重复扣；
//  - 金额以分存储，按分钟向下取整；
//  - 终点未确认只给 provisional（待核）金额，不得出最终对账行。
import { toEpoch, fenFor, periodOf, stableId } from './util.mjs';

const DEFAULT_TERM_ID = 'TERM-DEFAULT';

/** 兼容扁平 terms 与带生效区间的条款列表两种发布形态。 */
export function normalizeTerms(terms) {
  const list = Array.isArray(terms) ? terms : [terms];
  return list.map((t, i) => ({
    termId: t.termId ?? `${DEFAULT_TERM_ID}-${i + 1}`,
    line: t.line ?? null,
    from: t.effectiveFrom ? toEpoch(t.effectiveFrom) : null,
    until: t.effectiveUntil ? toEpoch(t.effectiveUntil) : null,
    freeMinutes: Number(t.freeMinutes ?? 0),
    fenPerMinute: Number(t.fenPerMinute),
    currency: t.currency ?? 'CNY',
    interval: t.interval ?? 'take-to-release',
    partyMode: t.party ?? 'party-during-interval',
  }));
}

function termActiveAt(term, epochMs) {
  return (term.from === null || term.from <= epochMs) && (term.until === null || epochMs < term.until);
}

/** 取覆盖某时刻的条款；同时命中多条时取最晚生效的一条，仍冲突则报错。 */
export function termAt(terms, epochMs) {
  const hits = terms.filter((t) => termActiveAt(t, epochMs)).sort((a, b) => (b.from ?? 0) - (a.from ?? 0));
  if (hits.length === 0) {
    const err = new Error('占用期间缺少有效合同条款');
    err.code = 'TERM_NOT_FOUND';
    throw err;
  }
  return hits[0];
}

/**
 * 计算单车压车账。
 * @param {object} occupancy buildOccupancy 的结果
 * @param {object[]} normalizedTerms normalizeTerms 的结果
 * @param {string} [asOfIso] 待核场景下的观察时刻（用于暂估已发生分钟）
 */
export function billOccupancy(occupancy, normalizedTerms, asOfIso = null) {
  if (!occupancy.confirmed) {
    // 待核：可给出按当前凭据的暂估，但不产生最终行。
    let provisional = null;
    if (occupancy.start) {
      const startMs = toEpoch(occupancy.start.time);
      // 观察终点：显式 asOf > 最新门禁 > 当前时刻。待核只暂估已发生的占用，不预测未来。
      const gateMs = occupancy.gateEvidence.map((g) => toEpoch(g.time));
      const throughMs = asOfIso
        ? toEpoch(asOfIso)
        : (gateMs.length ? Math.max(...gateMs) : Date.now());
      const effectiveMs = Math.max(startMs, throughMs);
      if (effectiveMs > startMs) {
        const rawMinutes = Math.floor((effectiveMs - startMs) / 60000);
        const term = termAt(normalizedTerms, startMs);
        const chargeable = Math.max(0, rawMinutes - term.freeMinutes);
        provisional = {
          observedThrough: new Date(effectiveMs).toISOString(),
          rawMinutes,
          freeMinutes: term.freeMinutes,
          chargeableMinutes: chargeable,
          fen: fenFor(chargeable, term.fenPerMinute),
          currency: term.currency,
          note: '终点待核，金额仅为当前暂估，不得作为最终对账行',
        };
      }
    }
    return {
      lineId: null,
      wagon: occupancy.wagon,
      intervalId: occupancy.intervalId,
      state: 'pending',
      pendingReasons: occupancy.pendingReasons,
      provisional,
      segments: [],
    };
  }

  const startMs = toEpoch(occupancy.start.time);
  const endMs = toEpoch(occupancy.end.time);

  // 责任时间轴：起点 party 取 take party；交接点覆盖之后的区间。
  const partyPoints = [
    { time: occupancy.start.time, party: occupancy.start.party },
    ...occupancy.handovers
      .filter((h) => toEpoch(h.time) > startMs && toEpoch(h.time) < endMs)
      .map((h) => ({ time: h.time, party: h.party })),
  ].sort((a, b) => toEpoch(a.time) - toEpoch(b.time));

  // 条款边界与责任边界取并集，切成内部条款/责任方恒定的小段。
  const boundaries = new Set([startMs, endMs]);
  normalizedTerms.forEach((t) => {
    if (t.from !== null && t.from > startMs && t.from < endMs) boundaries.add(t.from);
    if (t.until !== null && t.until > startMs && t.until < endMs) boundaries.add(t.until);
  });
  partyPoints.forEach((p) => {
    const ms = toEpoch(p.time);
    if (ms > startMs && ms < endMs) boundaries.add(ms);
  });
  const cuts = [...boundaries].sort((a, b) => a - b);

  const partyAt = (ms) => {
    let current = partyPoints[0].party;
    for (const p of partyPoints) {
      if (toEpoch(p.time) <= ms) current = p.party;
      else break;
    }
    return current;
  };

  const segments = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const segStartMs = cuts[i];
    const segEndMs = cuts[i + 1];
    const midMs = segStartMs + Math.floor((segEndMs - segStartMs) / 2);
    const term = termAt(normalizedTerms, midMs);
    segments.push({
      fromEpoch: segStartMs,
      toEpoch: segEndMs,
      rawMinutes: Math.floor((segEndMs - segStartMs) / 60000),
      party: partyAt(midMs),
      termId: term.termId,
      fenPerMinute: term.fenPerMinute,
      currency: term.currency,
    });
  }

  const rawMinutes = segments.reduce((s, x) => s + x.rawMinutes, 0);
  // 免计分钟在整个连续占用开头一次性扣减：按时间顺序从各段抵扣。
  let freeBudget = termAt(normalizedTerms, startMs).freeMinutes;
  segments.forEach((seg) => {
    const deduct = Math.min(freeBudget, seg.rawMinutes);
    seg.freeMinutes = deduct;
    seg.chargeableMinutes = seg.rawMinutes - deduct;
    seg.fen = fenFor(seg.chargeableMinutes, seg.fenPerMinute);
    freeBudget -= deduct;
  });

  const totalFen = segments.reduce((s, x) => s + x.fen, 0);
  const chargeableMinutes = segments.reduce((s, x) => s + x.chargeableMinutes, 0);

  // 按责任方汇总（合同 party 口径：party-during-interval）。
  const byParty = new Map();
  segments.forEach((seg) => {
    const cur = byParty.get(seg.party) ?? { party: seg.party, chargeableMinutes: 0, fen: 0, currency: seg.currency };
    cur.chargeableMinutes += seg.chargeableMinutes;
    cur.fen += seg.fen;
    byParty.set(seg.party, cur);
  });

  const lineId = stableId('LINE', [occupancy.wagon, occupancy.start.time, occupancy.end.time]);
  return {
    lineId,
    wagon: occupancy.wagon,
    intervalId: occupancy.intervalId,
    state: 'confirmed',
    period: periodOf(occupancy.end.time),
    startRef: occupancy.start.ref,
    endRef: occupancy.end.ref,
    rawMinutes,
    freeMinutes: segments.reduce((s, x) => s + x.freeMinutes, 0),
    chargeableMinutes,
    fen: totalFen,
    currency: normalizedTerms[0]?.currency ?? 'CNY',
    partyCharges: [...byParty.values()],
    segments,
    evidence: {
      start: occupancy.start,
      end: occupancy.end,
      supersededRefs: occupancy.supersededRefs,
    },
  };
}
