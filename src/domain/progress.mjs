// 调度员进度视图与班次交接。
// “车一到，调度员在运单下就要看到已收量和还缺的车辆联，接下一班也照此办。”
// 视图完全由谱系、占用与磅房事实派生，不回写原始凭据。

/**
 * @param {object} lineage buildLineage 结果
 * @param {Map<string, object>} occupancyByWagon 车号 -> buildOccupancy 结果
 * @param {Map<string, object[]>} segmentsByWagon 车号 -> 分段卸煤记录
 */
export function buildWaybillProgress(lineage, occupancyByWagon, segmentsByWagon) {
  const wagons = lineage.wagonLinks.map((link) => {
    const occ = occupancyByWagon.get(link.wagon);
    const segments = segmentsByWagon.get(link.wagon) ?? [];
    let stage;
    if (link.linkStatus === 'missing') stage = 'link-missing';
    else if (!occ) stage = 'in-transit';
    else if (occ.endStatus === 'confirmed') stage = 'returned-empty';
    else if (occ.startStatus === 'confirmed') {
      // 已在厂占用：终点未确认时，区分仍在卸与已卸待交还
      stage = segments.length > 0 ? 'unloaded-awaiting-release' : 'on-hold-plant';
    } else if (occ.startStatus === 'cargo-on-site') stage = 'start-pending-evidence';
    else stage = 'arrived-pending-take';

    return {
      wagon: link.wagon,
      train: link.train,
      dispatchRef: link.dispatchRef,
      linkStatus: link.linkStatus,
      attached: link.attached,
      stage,
      allocatedKg: link.allocatedKg,
      remainingInWagonKg: link.remainingKg,
      receivedKg: link.receivedKg,
      unloadSegments: segments,
      occupancy: occ
        ? {
            intervalId: occ.intervalId,
            startStatus: occ.startStatus,
            start: occ.start,
            endStatus: occ.endStatus,
            end: occ.end,
            pendingReasons: occ.pendingReasons,
          }
        : null,
    };
  });

  return {
    waybill: lineage.waybill,
    version: lineage.version,
    expectedKg: lineage.expectedKg,
    receivedKg: lineage.receivedKg,
    outstandingKg: lineage.outstandingKg,
    missingPages: lineage.missingPages,
    warnings: lineage.warnings,
    missingLinks: wagons.filter((w) => w.linkStatus === 'missing').map((w) => ({
      wagon: w.wagon,
      train: w.train,
      note: '编组页未发布导致的缺联，车辆未脱离运单',
    })),
    wagons,
  };
}

/**
 * 班次交接快照：下一班照此办理，看到的是同一份派生事实与待办。
 * @param {object} progress buildWaybillProgress 结果
 * @param {string} shiftId 班次标识
 * @param {string} takenAt 交接时刻 ISO
 */
export function buildShiftHandoff(progress, shiftId, takenAt) {
  const todos = [];
  // 缺页（目录声明但未发布）是下班要继续催的凭据，缺联不等于脱单。
  (progress.missingPages ?? []).forEach((p) => {
    todos.push({ wagon: null, action: `催要缺失编组页 ${p.page}（缺联，车辆未脱离运单）`, reason: p.reason });
  });
  progress.wagons.forEach((w) => {
    if (w.linkStatus === 'missing') {
      todos.push({ wagon: w.wagon, action: '催要缺失编组页', reason: 'link-missing' });
    }
    w.occupancy?.pendingReasons.forEach((r) => {
      todos.push({ wagon: w.wagon, action: r.message, reason: r.code });
    });
    if (w.stage === 'in-transit') {
      todos.push({ wagon: w.wagon, action: '继续盯途中位置', reason: 'in-transit' });
    }
  });

  return {
    shiftId,
    takenAt,
    waybill: progress.waybill,
    version: progress.version,
    summary: {
      expectedKg: progress.expectedKg,
      receivedKg: progress.receivedKg,
      outstandingKg: progress.outstandingKg,
      returnedEmpty: progress.wagons.filter((w) => w.stage === 'returned-empty').length,
      pending: progress.wagons.filter((w) => w.stage !== 'returned-empty').length,
    },

    missingPages: progress.missingPages,
    missingLinks: progress.missingLinks,
    todos,
  };
}
