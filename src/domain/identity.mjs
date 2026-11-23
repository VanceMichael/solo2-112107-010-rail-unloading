// 车辆身份解析：铁路车号与磅房稳定设备号之间，按“线别 + 生效日期”对应。
// 规则来自 registry 独立发布接口，同一车号在不同线别、不同时段可能对应不同设备号，
// 因此任何匹配都必须同时满足 line 与时间窗口 [from_time, until)；until 为 null 表示长期有效。
import { toEpoch } from './util.mjs';

export class IdentityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.details = details;
  }
}

export class IdentityResolver {
  /** @param {Array<{wagon:string,device:string,line:string,from_time:string,until:?string}>} registryRows */
  constructor(registryRows) {
    this.rows = registryRows.map((r) => ({
      wagon: r.wagon,
      device: r.device,
      line: r.line,
      from: toEpoch(r.from_time),
      until: r.until ? toEpoch(r.until) : null,
      raw: r,
    }));
  }

  activeAt(timeIso) {
    const t = toEpoch(timeIso);
    return this.rows.filter((r) => r.from <= t && (r.until === null || t < r.until));
  }

  /** 磅房设备号 -> 车号。line 与时间任一不匹配都视为无对应，禁止跨线别套用。 */
  resolveWagon(device, line, timeIso) {
    const hits = this.activeAt(timeIso)
      .filter((r) => r.device === device && r.line === line)
      .sort((a, b) => b.from - a.from);
    if (hits.length === 0) {
      throw new IdentityError(
        `设备号 ${device} 在 ${line} 线 ${timeIso} 无有效车号对应`,
        'IDENTITY_NOT_FOUND',
        { device, line, time: timeIso },
      );
    }
    if (hits.length > 1 && hits[0].from === hits[1].from) {
      throw new IdentityError(
        `设备号 ${device} 在 ${line} 线 ${timeIso} 存在多条同生效日期对应`,
        'IDENTITY_AMBIGUOUS',
        { device, line, time: timeIso, rows: hits.map((h) => h.raw) },
      );
    }
    return hits[0].wagon;
  }

  /** 车号 -> 磅房设备号（过磅归并、分段卸煤展示时使用）。 */
  resolveDevice(wagon, line, timeIso) {
    const hits = this.activeAt(timeIso)
      .filter((r) => r.wagon === wagon && r.line === line)
      .sort((a, b) => b.from - a.from);
    if (hits.length === 0) {
      throw new IdentityError(
        `车号 ${wagon} 在 ${line} 线 ${timeIso} 无有效设备号对应`,
        'IDENTITY_NOT_FOUND',
        { wagon, line, time: timeIso },
      );
    }
    if (hits.length > 1 && hits[0].from === hits[1].from) {
      throw new IdentityError(
        `车号 ${wagon} 在 ${line} 线 ${timeIso} 存在多条同生效日期对应`,
        'IDENTITY_AMBIGUOUS',
        { wagon, line, time: timeIso, rows: hits.map((h) => h.raw) },
      );
    }
    return hits[0].device;
  }
}
