// 通用时间与数值工具。全部按显式时区的 ISO-8601 字符串处理，不做隐式本地化。

/** 解析带时区的时间字符串，返回 epoch 毫秒；非法输入抛错。 */
export function toEpoch(iso) {
  if (typeof iso !== 'string' || !iso.trim()) {
    throw new TypeError('时间必须是非空 ISO-8601 字符串');
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`无法解析时间: ${iso}`);
  return ms;
}

/** 两个 ISO 时间之间的整分钟差（向下取整，按毫秒差截断）。 */
export function minutesBetween(fromIso, toIso) {
  const delta = toEpoch(toIso) - toEpoch(fromIso);
  if (delta < 0) throw new RangeError(`结束时间早于开始时间: ${fromIso} > ${toIso}`);
  return Math.floor(delta / 60000);
}

/** 账期：按时间字符串所在年月返回 YYYY-MM（账期归属以占用终点所在月为准；无终点时不允许出最终行）。 */
export function periodOf(iso) {
  const ms = toEpoch(iso);
  // 用 UTC 切片会被时区干扰，直接从字符串取年月；入参一律带偏移量。
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(iso);
  if (!m) throw new RangeError(`无法提取账期: ${iso}`);
  void ms;
  return `${m[1]}-${m[2]}`;
}

/** 分钟数按分/分钟单价换算为分（整数，向下取整）。金额一律以分存储，避免浮点误差。 */
export function fenFor(minutes, fenPerMinute) {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError('计费分钟数必须是非负整数');
  if (!Number.isFinite(fenPerMinute) || fenPerMinute < 0) throw new RangeError('单价非法');
  return Math.floor(minutes * fenPerMinute);
}

/** 分转元字符串，仅供展示。 */
export function fenToYuan(fen) {
  return (fen / 100).toFixed(2);
}

/** 稳定排序辅助：按 key 序列升序。 */
export function sortBy(list, keyFn) {
  return [...list].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

/** 生成确定性 ID（同输入同输出），用于对账行/占用区间编号，保证重跑结果可复算。 */
export function stableId(prefix, parts) {
  const joined = parts.map((p) => String(p)).join('|');
  let h = 2166136261;
  for (let i = 0; i < joined.length; i += 1) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}-${(h >>> 0).toString(36)}`;
}
