# ScoreFollow 识别基准集

## 当前状态
- 合成回归: `npm run regression` (纯函数, 无需浏览器/PDF)
- 合成谱端到端真值: `npm run synth` (`scripts/synth.mjs`, 程序生成已知几何谱面 →
  `countPixFromBuffer` 完整流水线 → 容差带对比；单系统/双系统+双小节线/符干干扰全过)
- 真谱抽查: `public/demo-score.pdf` + Secret Garden(外部谱, 见 HANDOFF)
- 目标 12 份 PDF 全覆盖前, 每次算法改动至少跑 `npm run verify` (tsc + regression + synth + build)

## 已知系统偏差
- plateau 取中后合成谱偏差归零(单/双系统/双小节线 meanDev 0.00)；跨引擎对比 meanDev 0.70px
  (HOMR 报框中心、我方报左缘的口径差, 在 TOL=4px 内)。

## GPU 交叉验证 (`benchmarks/gpu/`, `SF_BENCH_ROOT=benchmarks/gpu`)
- 用户提供 9 首真谱 27 页（大提琴/小提琴独奏+钢琴、咏叹调），GPU HOMR 全量 OMR，
  同一 compare 管线。注意 GPU 版 bbox 系为原始渲染像素（未除 scale），脚本已兼容。
- algo v6 记分牌（145/148 系统，tp=546，meanDev 0.70）：

| 谱 | tp | fp(v5→v6) | fn |
|---|---|---|---|
| Le Rêve | 32 | 0→0 | 0 |
| Vivaldi 咏叹调 | 76 | 1→1 | 2 |
| Arpeggione | 55 | 1→0 | 3 |
| La Paloma | 59 | 6→4 | 0 |
| Swan 独奏 | 45 | 19→14 | 0 |
| kupdf 钢琴伴奏 | 98 | 22→14 | 18 |
| Serenade 小提琴 | 82 | 57→34 | 9 |
| Suzuki Scherzo | 57 | 76→38 | 2 |
| Rococo 大提琴 | 42 | 319→114 | 13 |

- v6 修了独奏谱符干误报（fp 505→223）：否决"净杆+脏端"候选
  （端窗宽行≥4 且 游程≥0.9 且 中段干净）。残留两类：梁丛符干（中段脏）、
  符头在谱表外的净杆（像素级不可分，理论上限）；5 个误杀已记录待仲裁。
- algo v8（人工真值口径，`scripts/gt-eval.py`，ref=542）："符干必连符头，
  小节线永不相接"。新增 `noteheadProximity`（与杆连通的符头级宽段[5,2sp+4]
  高≥4 行；谱线行跳过不断段；扫描上延 3sp、下延至游程端+sp；xi±1 三列测宽
  抗 NMS 峰偏）+ `midWidth≥6` 否决梁丛。v6→v8：fp 252→87（-65%），fn 25→26，
  tp 517→516，precision 0.672→0.856，recall 0.954→0.952。Rococo fp 114→2。
  诊断工具：`gt-feat-profile.mjs [score] [TP|FP|FN]`（GT 口径画像）、
  `rowscan.mjs <score> <page> <sys> <x>`（逐行宽表）、`debugBarColumn()`。
- v8 残余 FP 分类（87）：kupdf 34 系统分组错位（p2 4vs7 非判别问题）；
  升号竖笔画（ser/kupdf 已确认 4 例）；短杆 bypass（swan run<0.9，
  降门槛会误杀 arpeggione 36 个 TP，不动）；系统起始粗线（口径切除[1:-1]）；
  反复记号粗线 mid=9 被 mid≥6 规则误杀 1 个（ser p4@216，接受）。
- algo v9 系统分组：`countVsys` 同时用括号亮度跳变 `k` 与垂直间距。
  合并当 `k >= 8*spatium` 且（k 落在高簇 **或** 间距 `<= 8*spatium`）。
  修 Suzuki p1 误合并（假 k≈60 < 80）与 kupdf 大谱表第一间隙弱括号
  （k≈128 但非高簇，靠小间距 47–53px 合并）。v8→v9：tp 516→525，
  fp 87→51，fn 26→17，precision 0.856→0.911，recall 0.952→0.969。
  9/9 首系统数与 GT 对齐（gt_sys=144 our_sys=145）。
- algo v10–v16 小节线否决收敛（`barColumnVetoed`，候选+NMS 后复核共用）：
  v10 谱号区 `x-x1<80` 否决（TP 最小 dx=99，零风险，fp-12）；
  v11 窄谱表（H≤6.5sp）细短杆 `run<0.95 & mid≤2` 否决（swan 13→1）；
  v12 NMS 后终检位置复核（NMS 中位数可漂 1-2px，525 TP 零命中）；
  v13 `mid≥6` 门槛 0.7→0.6；v14 升号弱双竖
  `twinDist∈[4,6] & twinRel∈[0.55,0.65)`（TP 最小 0.708）；
  v15 短符干 `run≥0.8 & prox≥1 & blob≥6`；v16 v1 规则 run 门槛 0.9→0.8。
  v9→v16：fp 51→16，fn 17 不变，precision 0.911→0.970。
  否决实验：xi±2 五列测宽回退（Le Rêve FN+19，邻音符头扫入）；
  NMS 后 ±2 邻域否决回退（5 个 TP 被邻柱误杀）。
- v16 残余 16 FP：serenade 3 / suzuki 4（升号竖笔画或 1px 邻接符干，
  几何特征已到极限）/ swan 1 / kupdf 2 / paloma 6（未配对系统，
  属系统分组残差）。17 FN 中 rococo 7、serenade 5 为主。
  诊断工具：`gt-feat-profile.mjs`（GT 口径画像）、`nb-veto-check.mjs`
  （TP 邻域否决安全检查）、`pxdump.mjs`（像素 ASCII 图）、
  `rowscan.mjs`（逐行宽表）、`debugBarColumn()`。
- algo v25（2026-10-04）：v24 基线复测（ours.json 停在 v22, v23/v24 对本集零变化）536/12/7 P0.978 R0.987。
  逐条归因 7 FN（插桩 findBarLines 4 处静默 continue + barColumnVetoed 子句级标签, 复现与 ours.json 27 页逐系统一致）：
  4 条为 NMS 前 `barColumnVetoed` 组合 return(L1183)误杀——C1 blob(Serenade p4s2 609/866)、
  C7 横梁(Suzuki p1s4 555)、C2 近头(Suzuki p2s4 326)；真线 run 0.96~1.0/mid=3, 与同谱符干单列同形
  (GT 全集 veto-pre 541 簇中 run≥0.95&mid≤3 的非真线 192 个), 单列几何不可分, 不改 veto。
  上下文可分: 误杀线都落在异常宽空档(Serenade 458→941=3.1×med, Suzuki 354→757=2.0×med)。
  既有 `rescueWideGapBars`(widrescue, 原默认关)实测零救回, 两道护栏: ①右端空档被当贴边跳过
  (两例宽空档右端都是终线) ②mask 关时救回走全套 barColumnVetoed, 同一子句再杀一次。
  修: 只跳过贴左边空档(谱号/调号/缩进); `barColumnVetoedRescue` mask 关时只留形状类 + run≥0.9;
  widrescue 默认开。GT 538/12/5 P0.978 R0.991（Serenade 609、Suzuki 555 救回, FP 零增加）。
  变体证伪: 全段搜索代替等分预测窗 539/14/4（+Serenade 866, 但 p4s2-710/p4s8-246 符干混入, F1 降）;
  notemask=1 +11FP。剩余 FN: Serenade 866（二次等分预测 775≠866, 小节不等宽）、Suzuki p2s4 326
  （空档 213 不宽, 无上下文证据）、Suzuki p1s1 331（定位 326 偏 5px, 同源 FP）、Rococo p2s3 524
  （系统吸入 3 条外谱线, rel 0.60 未过强度门）、Vivaldi p5s1 423（对比门）。
  HOMR 套件 61/0/1 与 v24 逐行一致, ADJUDICATION_FAIL(1)=Toccatta 167 待仲裁(既有, 见 AUDIT-REPORT)。
  `scripts/gt-eval.py` 路径改相对仓库根(原写死 main worktree, 在 opt 评测会读到 main 的旧 fixture)。
- 数据再生：`python3 scripts/gpu-data.py [slug...]`（GPU 端点见脚本头）。

## HOMR 交叉验证 (`benchmarks/homr/`, `npm run homr`)
- 独立 OMR 引擎 (本机 :8000, segnet) 与我方像素算法互验：Secret Garden 2 页 + Toccatta 3 页，
  按系统 y 交叠配对、内部小节线容差 4px 对比。
- 当前记分牌 (algo v5)：24/24 系统配对成功，tp=61 fp=1 fn=1，meanDev 0.71px；
  2 处分歧经放大的 overlay  PNG 人工仲裁，均为 HOMR 错误（见 `adjudicated.json`），
  仲裁后我方 7 页全对。`homr-compare.mjs` 含仲裁门禁：未覆盖的新分歧直接失败。
- 数据再生：`homr/.venv/bin/python scripts/homr-data.py`（需本机 HOMR 服务 + venv 的 fitz）。
  `*.raw` / `*.png` 已 gitignore；`meta.json` / `homr.json` / `ours.json` / `adjudicated.json` 为提交 fixture。
- 关键修复（均由本轮分歧驱动，均有回归锁定）：
  1. voorna 对比门误杀浓墨区真小节线 → 直度≥0.9 豁免（`columnRunRatio`）。
  2. 等强 plateau 取最左 → 簇中位数（强弱悬殊>0.15 则取最强，保底）。
  3. 左端点无条件强制 → 首条线距边 <3 spatium 时从首条线起（去琴架碎片小节）。
  4. countVsys 中部亮度绝对阈值（6 列）误杀 D.S./Coda 缺口系统 → 相对阈值 max(5, 3%宽)。
  5. 系统 x 范围取最宽单游程 → 宽游程（>10 spatium）并集，Coda 半段不再丢失。

## 标注格式 (每页一个 JSON)
```json
{
  "pdf": "demo-score.pdf",
  "page": 1,
  "renderWidth": 1000,
  "systems": [{ "x1": 20, "y1": 52, "x2": 379, "y2": 92 }],
  "bars": [[20, 139, 259, 379]],
  "measureCount": 3
}
```
字段与 `PageAnalysis` 对齐: `systems[].cs/xs`, `bars[system][x...]`。
新增标注放 `benchmarks/suites/*.json`, 回归脚本会自动汇总 precision/recall/x 偏差/系统 IoU。

## 回归指标
- 内部小节线 precision / recall (容差 `max(2px, 0.2*spatium)`)
- 平均 x 偏差
- 系统框 IoU
- 异常页清单 (低置信度 / 数量突变)
