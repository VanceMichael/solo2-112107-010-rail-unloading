// 计量凭据归并：磅房 CSV 中重复磅单（完全重复行）与手工补登（沿用同一计量号）
// 都必须归并为同一凭据，不允许重复计重。一车两次卸煤保留为两条分段记录。
import { toEpoch } from './util.mjs';

/**
 * 归并过磅行。
 * @param {Array<Record<string,string>>} csvRows parseCsv 的结果
 * @param {IdentityResolver} identity 设备号→车号
 * @returns {{vouchers: Map<string, object>, warnings: object[]}}
 */
export function mergeWeighVouchers(csvRows, identity) {
  const byTicket = new Map();
  const warnings = [];

  csvRows.forEach((row, index) => {
    const ticket = row.ticket?.trim();
    const line = row.line?.trim();
    const device = row.device?.trim();
    if (!ticket || !line || !device) {
      throw new TypeError(`第 ${index + 2} 行磅单缺少 ticket/line/device`);
    }
    const timeIso = row.time;
    const netKg = Number(row.net_kg);
    if (!Number.isFinite(netKg)) throw new TypeError(`磅单 ${ticket} 净重非法: ${row.net_kg}`);
    const wagon = identity.resolveWagon(device, line, timeIso);
    const side = row.side?.trim() || 'unload';
    const fingerprint = [line, device, timeIso, netKg, side].join('|');

    const existing = byTicket.get(ticket);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        // 完全重复的磅单：合并为同一凭据，仅累计出现次数，重量不重复加。
        existing.duplicateCount += 1;
        return;
      }
      // 同一计量号但内容不同 = 手工补登/更正：以同凭据归并，保留两段，给出可追溯告警。
      existing.supplements.push({ line, device, time: timeIso, netKg, side, rowIndex: index + 2 });
      warnings.push({
        code: 'VOUCHER_SUPPLEMENT',
        ticket,
        message: `计量凭据 ${ticket} 出现内容不同的补登行，已归并并保留分段`,
      });
      return;
    }

    byTicket.set(ticket, {
      ticket,
      line,
      device,
      wagon,
      // 首次过磅事实；补登行进入 supplements，主时间取最早一笔。
      time: timeIso,
      timeEpoch: toEpoch(timeIso),
      netKg,
      side,
      fingerprint,
      duplicateCount: 1,
      supplements: [],
      rowIndex: index + 2,
    });
  });

  return { vouchers: byTicket, warnings };
}

/**
 * 按车汇总分段卸煤记录（同一车号的全部凭据按时间排序），并返回每车实收净重。
 * 分段不合并重量条目，满足“一车两次卸煤要看到分段记录”。
 */
export function unloadSegmentsByWagon(voucherMap) {
  const byWagon = new Map();
  for (const v of voucherMap.values()) {
    const segments = byWagon.get(v.wagon) ?? [];
    segments.push({ ticket: v.ticket, time: v.time, netKg: v.netKg, side: v.side, supplement: false });
    v.supplements.forEach((s, i) => {
      segments.push({
        ticket: v.ticket,
        time: s.time,
        netKg: s.netKg,
        side: s.side,
        supplement: true,
        supplementIndex: i + 1,
      });
    });
    byWagon.set(v.wagon, segments);
  }
  for (const segments of byWagon.values()) {
    segments.sort((a, b) => toEpoch(a.time) - toEpoch(b.time));
  }
  return byWagon;
}

export function receivedKgByWagon(segmentsByWagon) {
  const totals = new Map();
  for (const [wagon, segments] of segmentsByWagon.entries()) {
    totals.set(wagon, segments.reduce((sum, s) => sum + s.netKg, 0));
  }
  return totals;
}
