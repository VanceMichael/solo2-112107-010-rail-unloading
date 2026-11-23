// 运单—车联谱系。
// 关键业务约束：
//  1. 重车在编组站拆成两个车列（reform）只换列车、不换车，原运单不脱联；
//  2. 中途目录改版时，索引声明的页尚未发布（采集端 404）属于“缺联”，
//     绝不能被当作车辆已脱离当前运单；
//  3. 换装（transload）货物跟实际接收车走，生成新车联；旧车保留未转出部分，
//     仍用原车确认，运单号自始至终不变。
import { toEpoch, sortBy } from './util.mjs';

/**
 * 构建运单车联谱系。
 * @param {object} index dispatch-index {waybill, version, pages: string[]}
 * @param {Map<string, object[]|null>} pagesByName 页名 -> 发车编组记录；null 表示该页未发布（404 缺联）
 * @param {object[]} changes 中途换编/换装记录
 * @param {Map<string, number>} receivedByWagon 车号 -> 已卸净重（来自磅房归并）
 */
export function buildLineage(index, pagesByName, changes, receivedByWagon) {
  const waybill = index.waybill;
  const links = new Map();
  const linkOrder = [];
  const missingPages = [];
  const warnings = [];

  const upsertLink = (wagon) => {
    if (!links.has(wagon)) {
      const link = {
        waybill,
        wagon,
        train: null,
        dispatchRef: null,
        depart: null,
        allocatedKg: 0,
        remainingKg: 0,
        attached: true, // 缺联/换编都不置 false；只有显式 detach 事件才脱联
        present: false, // 是否已在已发布的发车页中观察到
        events: [],
      };
      links.set(wagon, link);
      linkOrder.push(wagon);
    }
    return links.get(wagon);
  };

  // 1) 先扫描中途事件，识别每个换装接收车被转入的货量，避免“换装后车辆清册页”
  //    把已按换装凭据分配过的货物再计一次（D2 新增页记录的是换装后车辆事实）。
  const transloadInKg = new Map(); // wagon -> 累计转入量
  changes.filter((c) => c.waybill === waybill).forEach((c) => {
    if (c.type === 'transload') {
      transloadInKg.set(c.to_wagon, (transloadInKg.get(c.to_wagon) ?? 0) + c.kg);
    }
  });

  // 2) 回放已发布发车编组页，建立初始车联。
  index.pages.forEach((pageName) => {
    const rows = pagesByName.get(pageName);
    if (rows === null || rows === undefined) {
      missingPages.push({ page: pageName, reason: 'PAGE_NOT_PUBLISHED' });
      warnings.push({
        code: 'MISSING_LINK',
        page: pageName,
        message: `目录声明的编组页 ${pageName} 尚未发布，按缺联处理，运单 ${waybill} 不脱联`,
      });
      return;
    }
    rows.filter((r) => r.waybill === waybill).forEach((r) => {
      const link = upsertLink(r.wagon);
      link.present = true;
      link.train ??= r.train;
      link.dispatchRef ??= r.ref;
      link.depart ??= r.depart;
      link.events.push({
        kind: 'dispatch',
        ref: r.ref,
        train: r.train,
        time: r.depart,
        kg: r.coalKg,
        page: pageName,
      });
      if (transloadInKg.has(r.wagon) && transloadInKg.get(r.wagon) === r.coalKg) {
        // 换装后清册事实：页行货量与换装转入量一致，货量已由 transload-in 承接，
        // 本页不再重复累加分配量（页仍作为观察事实保留在 events 中）。
        link.events[link.events.length - 1].absorbedByTransload = true;
        warnings.push({
          code: 'TRANSLOAD_PAGE_FACT',
          page: pageName,
          wagon: r.wagon,
          message: `页 ${pageName} 中 ${r.wagon} 为换装后清册事实，货量以换装凭据为准，不重复计分配`,
        });
        return;
      }
      link.allocatedKg += r.coalKg;
      link.remainingKg += r.coalKg;
    });
  });

  // 3) 按时间回放中途换编/换装。
  const ordered = sortBy(changes.filter((c) => c.waybill === waybill), (c) => toEpoch(c.time));
  for (const change of ordered) {
    if (change.type === 'reform') {
      // 换编：from/to 同车，只承接列车关系。
      const link = upsertLink(change.from_wagon);
      link.train = change.train;
      link.events.push({
        kind: 'reform',
        ref: change.ref,
        train: change.train,
        predecessor: change.predecessor,
        time: change.time,
        kg: change.kg,
      });
      continue;
    }

    if (change.type === 'transload') {
      const from = upsertLink(change.from_wagon);
      if (from.remainingKg < change.kg) {
        warnings.push({
          code: 'TRANSLOAD_OVERDRAFT',
          ref: change.ref,
          message: `换装单 ${change.ref} 转出量 ${change.kg}kg 超过 ${change.from_wagon} 剩余 ${from.remainingKg}kg`,
        });
      }
      from.remainingKg = Math.max(0, from.remainingKg - change.kg);
      from.events.push({
        kind: 'transload-out',
        ref: change.ref,
        toWagon: change.to_wagon,
        train: change.train,
        time: change.time,
        kg: change.kg,
      });

      const to = upsertLink(change.to_wagon);
      to.train = change.train;
      to.allocatedKg += change.kg;
      to.remainingKg += change.kg;
      to.events.push({
        kind: 'transload-in',
        ref: change.ref,
        fromWagon: change.from_wagon,
        train: change.train,
        time: change.time,
        kg: change.kg,
      });
      continue;
    }

    if (change.type === 'detach') {
      // 显式脱联（如确有该类凭据）；缺页绝不是 detach。
      const link = upsertLink(change.from_wagon);
      link.attached = false;
      link.events.push({ kind: 'detach', ref: change.ref, time: change.time });
      continue;
    }

    warnings.push({
      code: 'UNKNOWN_CHANGE_TYPE',
      ref: change.ref,
      message: `未识别的中途记录类型: ${change.type}`,
    });
  }

  // 3) 汇总每车实收与状态。已卸量按车号归集，换装后接收车的过磅自然落到接收车。
  const wagonLinks = linkOrder.map((wagon) => {
    const link = links.get(wagon);
    const receivedKg = receivedByWagon.get(wagon) ?? 0;
    return {
      ...link,
      receivedKg,
      unloaded: receivedKg > 0,
      // 已观察到（页已发布）或已在换编/换装凭据中出现，即视为联已接上；缺联只来自未发布页。
      linkStatus: !link.present && link.events.length === 0 ? 'missing' : 'linked',
    };
  });

  const expectedKg = wagonLinks.reduce((s, l) => s + l.allocatedKg, 0);
  const receivedKg = wagonLinks.reduce((s, l) => s + l.receivedKg, 0);
  // 原发运量守恒口径：发车页分配量之和（换装转入不新计货物，转出不消失，只换承载车）。
  const originalDispatchedKg = wagonLinks
    .reduce((s, l) => s + l.events.filter((e) => e.kind === 'dispatch' && !e.absorbedByTransload).reduce((k, e) => k + e.kg, 0), 0);
  const transferredKg = wagonLinks
    .reduce((s, l) => s + l.events.filter((e) => e.kind === 'transload-in').reduce((k, e) => k + e.kg, 0), 0);

  return {
    waybill,
    version: index.version,
    expectedKg,
    originalDispatchedKg,
    transferredKg,
    receivedKg,
    // 还缺量按原发运量守恒口径（实收不会因换装重复计）。
    outstandingKg: Math.max(0, originalDispatchedKg - receivedKg),
    missingPages,
    warnings,
    wagonLinks,
  };
}
