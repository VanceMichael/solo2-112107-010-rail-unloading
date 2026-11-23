# 保供煤列车压车凭据与对账系统

在 `source.mjs` 合成来源服务之上构建的业务应用。调度员按运单采集发车编组、中途换编换装、
磅房过磅、门禁与厂内交车凭据；财务按 **take→release 的实际车辆占用** 核对压车费，
证据不完整的车辆只报待核、不出最终对账行。

## 业务规则与代码对应

| 规则 | 实现位置 |
| --- | --- |
| 车号↔稳定设备号必须按**线别+生效日期**对应，禁止跨线/跨期套用 | `src/domain/identity.mjs` |
| 重复磅单与手工补登按**同一计量凭据**归并，重量不重复计 | `src/domain/vouchers.mjs` |
| 一车两次卸煤保留**分段记录**，实收为分段之和 | `unloadSegmentsByWagon` |
| 编组站拆列（reform）不换车不脱单；中途目录缺页是**缺联**而非车辆脱离运单 | `src/domain/lineage.mjs` |
| 换装（transload）货物跟实际接收车走，旧车保留未转出部分、仍用原车确认；运单号不变 | `buildLineage` |
| 换装后清册页（如 D3）是当前车辆事实，货量以换装凭据为准，不重复计分配 | `TRANSLOAD_PAGE_FACT` 分支 |
| 占用区间 = take 到 release；**最后一次卸货不能代替空车交还** | `src/domain/occupancy.mjs` |
| 门禁晚写入区分“货物已在场”与“占车起点待证”，缺 take 不臆断责任方 | `startStatus=cargo-on-site` |
| release 被新单 `supersedes` 时以新单计时，旧单保留可追溯 | `supersededRefs` |
| 免计分钟只在每次连续占用开头扣一次；责任方/条款按占用期间有效凭据分段 | `src/domain/billing.mjs` |
| 金额以**分**整数存储，按分钟向下取整 | `fenFor` |
| 终点未确认只出 `pending` 暂估，`lineId=null`，禁止发最终行 | `billOccupancy` |
| 证据完整车辆逐车独立确认，同运单其他车未核完不连带挂起 | `src/domain/reconciliation.mjs` |
| 更正触及已确认行：红冲原计费区间 + 替换行 + 待冲抵范围，可追溯原 lineId | `buildReversal` |
| 财务压车单回查：车号/起止凭据/分钟数/账期比对，差异列争议并保留原记录 | `crossCheckLedger` |
| 调度员进度（已收量、还缺车联、占用阶段）与班次交接快照 | `src/domain/progress.mjs` |
| 原始凭据只追加，更正以新事件表达；可整体重放复算 | `src/storage/store.mjs` |
| 门户上报按业务键幂等，重发拿原回执；503 本地排队不丢凭据 | `src/app/portal.mjs` |

## 目录结构

```
src/
  domain/      纯领域逻辑（无 IO，可独立单测）
    identity.mjs     车号/设备号线别+有效期解析
    vouchers.mjs     磅单凭据归并、分段卸煤
    lineage.mjs      运单—车联谱系（缺联/换编/换装）
    occupancy.mjs    占用区间事实（take/release/门禁/替代链）
    billing.mjs      免计、责任方分段、待核暂估
    reconciliation.mjs 确认、冲抵、台账回查
    progress.mjs     调度进度与班次交接
    util.mjs         时间、分钟、分/元、确定性 ID
  source/      来源接入（HTTP/文件双模式、CSV 解析）
  storage/     仅追加事件存储（JSON 原子写）
  app/         应用编排（采集、重建、确认、更正、门户）
bin/cli.mjs   命令行入口
test/         node:test 测试（29 个用例）
```

## CLI 用法

数据文件默认写 `data/events.json`，可用 `--store` 改位置。离线用 `--mode file` 直读 `wire/`，
联调用 `--mode http --base http://127.0.0.1:4173`。

```bash
# 1) 按阶段采集（404 页登记为缺联，不产生脱单判断）
node bin/cli.mjs ingest --phase opening
node bin/cli.mjs ingest --phase interim
node bin/cli.mjs ingest --phase confirmed

# 2) 调度员看运单进度（已收量/缺车联/每车占用阶段与分段卸煤）
node bin/cli.mjs progress
node bin/cli.mjs handoff --shift S-night --at 2026-11-27T20:00+08:00

# 3) 压车计费；待核车用 --asof 给观察时刻出暂估（仍非最终行）
node bin/cli.mjs bills --asof 2026-11-27T12:20+08:00

# 4) 确认证据完整车辆（逐车独立，不被同运单待核车挂起）
node bin/cli.mjs confirm

# 5) 更正处理：Y2A 替代 Y2 等触及已确认行时生成待冲抵包
node bin/cli.mjs correct

# 6) 月底财务用自有压车单回查争议
node bin/cli.mjs ledger-check

# 7) 门户幂等上报（需 http 模式）
node bin/cli.mjs post --mode http --phase confirmed
node bin/cli.mjs post-credits --mode http --phase confirmed

node bin/cli.mjs summary   # 一页式汇总
```

## 内置数据场景（F221，east 线）

三阶段发布演进恰好覆盖全部规则：

- **opening**：D1 发车 W-32(55t)/W-33(42t)；yard 给 W-32 的旧 release `Y2`(11:20)；台账 L1 按 180 计费分钟确认。
- **interim**：目录升 D2 声明 `train-c` 但页未发布（404 缺联）；换装 C2 已发布，W-51 经 transload-in 接联且**不脱单**；
  磅单 V4 重复一行被归并；W-51 只有 take 无 release → 待核。
- **confirmed**：train-c 补发 D3（换装后清册，不重复计分配）；`Y2A` 替代 `Y2`，W-32 计费分钟 180→150，
  已确认行产生 −36000 分红冲、30000 分替换行、净 −6000 分；财务 L1 回查落 `charged_minutes` 争议且原记录可对上。

计费口径（terms：免计 60 分钟，200 分/分钟）：

| 车 | 占用 | 计费分钟 | 金额（分） | 状态 |
| --- | --- | --- | --- | --- |
| W-32 | 07:20→10:50（Y2A） | 150 | 30000 | confirmed，旧 L1 待冲抵 |
| W-33 | 09:30→12:30 | 120 | 24000 | confirmed |
| W-51 | 08:20 起，release 缺 | 暂估 180（观察到 12:20） | 暂估 36000 | pending，不出最终行 |

## 测试

```bash
npm test          # 29 个领域/端到端用例
node --test source.test.mjs   # 原有合成来源契约测试（保持通过）
```
