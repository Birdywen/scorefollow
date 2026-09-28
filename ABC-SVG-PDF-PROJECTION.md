# ABC → PDF 符头隔空投射（AlignEngine v11 核心）

## 定位与来源

这是 Smart-Metro 与 livescore 共用的**已建立的投射算法**：利用 abc2svg 的排版位置、SynPDF 在 PDF 页面上检测的谱线/小节线，在不识别 PDF 音符语义的情况下预测符头位置。算法实现以 `/home/ubuntu/workspace/Smart-Metro/align-engine.js` 为准：文件头将几何核心称为 **v11**，当前脚本自报 `version: 1.2.0`、`versionName: v13-reviewed-or-candidate-module-x`；这些是不同层次的版本号，不应混为一谈。此文档记录现有算法，不把 scorefollow 的 CV 小节线检测和 ABC 投射混为同一模块。

输入：按谱行切分的 ABC；abc2svg 的 `anno_start` 与 `get_abcmodel` 回调；PDF 对应行的 `cs`（两组各 5 条谱线 y）、`bxs`（按 x 排序的小节边界）；可选显示比例 `scale`。输出：`heads[]`，每个符头含 `png_x/png_y`、`pit/st/v`、`measureInRow/localTick` 等。这里的 `png_*` 指**与输入 PDF/PNG metric 相同的页内像素坐标空间**乘以 `scale`，不是浏览器视口坐标；若叠到 DOM，仍须处理画布偏移/尺寸。

数据契约（`metric_arr`）：`[baseWidth, { cxs: [{ cs, xs }, ...], bxs: [[x0, x1, ...], ...] }, ...]`。每行 `cs[0..4]` 是高音谱表的自上而下 5 线，`cs[5..9]` 是低音谱表；`bxs[i]` 和 `bxs[i+1]` 夹住第 `i+1` 小节。scorefollow 侧由 `app/page.tsx` 的 `buildMetricArr()` 提供该格式，节拍器 `public/metro-engine.js` 也消费这个 metric；ABC→符头坐标目前由外部 `align-engine.js` 实现，并未因此自动接入 scorefollow 页面。

## 从 abc2svg 提取锚点和身份

`renderRow(rawAbc)` 先去掉内联 `[K:...]`，调用 `new abc2svg.Abc(callbacks).tosvg(...)`：

- `anno_start` 收集 note/rest 的 SVG 注释框 `{x,y,w,h,s,e}`，bar 的 x；取**所有收到的注释 x 的最小值**作 `svgLeftMost`（不仅是符头）。bar 的 x 排序，并把距离 `≤1` 的重复线合并成 `uniqBars`。
- `get_abcmodel` 沿 `ts_next` 抽取音符符号：ABC 字符区间 `istart/iend`、`time`、谱表索引 `st`、声部 `v`，以及和弦内各音的 `pit/shhd/noteOrdinal`。模型符号用 `istart === anno.s` 与 note 注释关联。
- bar 模型推进 `measureInRow`，`localTick = symbol.time - measureStartTime`；这里是 **abc2svg 的时间单位**。若要和 MusicXML 的 divisions/tick 对齐，先显式统一时间单位，不可直接把两边数值相等当作同一时刻。

## X：小节内的 SVG 相对位置 → PDF 横坐标

令 `B[i] = bxs[i]`，`U[i] = uniqBars[i]`，小节数为 `bxs.length - 1`，`x` 是已修正的符头 SVG x。算法按行、按小节独立归一化，避免把 SVG 整行等比例拉伸到扫描页：

| 小节（0 起） | SVG 左/右锚 | 相对位置 `t` | PDF x |
| --- | --- | --- | --- |
| `i = 0` | `svgLeftMost, U[0]` | `(x - svgLeftMost)/(U[0] - svgLeftMost)` | `(B[0] + t·(B[1]-B[0]))·scale` |
| `i ≥ 1` | `U[i-1], U[i]` | `(x - U[i-1])/(U[i]-U[i-1])` | `(B[i] + t·(B[i+1]-B[i]))·scale` |

由 x 落入哪个 SVG 锚区间决定小节，判定时允许 `±0.5` 的边缘宽容。首小节的比例 `ratioX_first = (B[1]-B[0])/(U[0]-svgLeftMost)`，由实际左锚确定，不用猜一个固定的首音偏移；后续各小节按各自的局部区间投射。`ratioX_other` 则是后续小节宽度比 `(B[i+1]-B[i])/(U[i]-U[i-1])` 的**中位数**，仅用于下述二度音错开和输出诊断的 `scaleX`，不是后续小节 X 位置统一使用的比例。

符头 x 修正按源码实际分支：

- 普通单音/和弦成员：`x = anno.x + (有升降/还原号 ? 8.3 : 0) + note.shhd`。
- 若该符号的任意两个 `pit` 相差 1（**谱表级相邻音，不是半音差 1**），以 `centerSvg = anno.x + anno.w/2` 为基准；相邻对的低音 `x = centerSvg - gap/ratioX_other`，其他音取 `centerSvg`；若有临时记号，再加 `8.3`。`gap` 使用对应谱表的线间距。这里不用普通分支的 `shhd`。

`ACC_SHIFT=8.3` 和上述二度修正是该实现的排版补偿常量，不是通用的 PDF→SVG 变换。`FIRST_NOTE_SVG_OFFSET=12` 虽在常量表中声明，但当前 `alignRow` **没有使用**它计算首小节位置。

## Y：模型谱表音高 → PDF 纵坐标

Y **不从 SVG y 拉伸**，而由音符模型的谱表音高 `pit` 和 PDF 谱线直接推算。令 `gapT=cs[1]-cs[0]`、`gapB=cs[6]-cs[5]`：

```text
st !== 1 （高音谱表）: png_y = (cs[4] - (pit - 18)·gapT/2)·scale
st === 1 （低音谱表）: png_y = (cs[9] - (pit -  6)·gapB/2)·scale
```

`18`、`6` 分别是这个 abc2svg 模型和该谱表配置的 E4、G2 锚点；`pit` 是逐个**自然音级**递增的谱表级坐标，不能代入 MIDI semitone（例如 C4=60）或按半音计算 `gap/2`。`st` 是 abc2svg 的谱表编号；变调/临时升降号不直接改变纸面谱线高度。若换谱号、换谱表布局或转换器改变 pit 语义，应重新核实锚点。

## 使用边界与跨项目衔接

- 必须确保 ABC 行和 PDF 行、小节一一对应，并且 SVG 锚区间非零。`alignRow` 遇到 bar 数不足时返回空 `heads`；不代表该行没有音符。
- 传给 `alignRow` 的 `homrBars` 若非空，会**替代** `bxs` 做 X 锚点（源码的 `opt.homrBars || opt.bxs`），而非与 SynPDF 小节线自动仲裁。因此闭环中先以审后 `metric_arr.bxs` 固定小节身份，再把 HOMR 检测作为互验证据，不要把未审的 bar 列表直接当权威边界。
- `alignAll()` 包装层有未定义变量 `page` 的引用（HOMR 分支的 `metricArr[page]`，在 `abcRows.forEach` 定义 `page` 之前）；另有 `rowInPage = idx - (page-1)*5` 的每页固定 5 行假设。独立复用 `alignRow` 核心时不依赖这些假设；接入 `homrData` 前需修复并验证包装层。
- `moduleXResolver` 是后加的 X 覆盖层：以 `m{measure}:t{localTick}` 查精确时刻，校验 page/row 与 metric 边界后替换 `png_x`，保留原投射的 Y/谱表/声部信息。`alignAll` 实际调用 `applyReviewedModuleX`，所以其调用路径要求 `REVIEWED + READY_REVIEWED`；`applyModuleX` 本身还接受 candidate，勿误读为包装层也接受。
- 在 livescore 闭环里，XML 负责音符语义，ABC/abc2svg 提供模型符号及投射，SynPDF reviewed metric 提供小节线/谱线，HOMR 提供实际 bbox。将 `measure/localTick`、谱表/声部和音高**明确换算后**再与 XML/onset 和 HOMR bbox 配对；不能仅靠 x 接近认定同一符头。

## 验证记录与证据口径

`align-engine.js` 文件头记录：Serenade（3/4、2 声部）与 Adagio（4/4、3 声部）跨曲测试均为“0 遗漏”。这是既有实现注明的验证结论；源码没有附带逐音像素误差和两曲完整的测试报告，不能据此推导对所有谱号的精度，也不等于当前 scorefollow 已集成并复测。后续若对新曲做验收，应分别记录 `stats.matched/unmatched/missed`、投射 vs HOMR 的坐标残差、以及审后小节线冲突；不要以生成了 `heads` 就替代位置精度检查。

实现定位：`/home/ubuntu/workspace/Smart-Metro/align-engine.js` 的 `renderRow`（61–107）、`alignRow`（111–202）、`alignAll`（206–287）；本仓的 metric 生产见 `app/page.tsx` 的 `buildMetricArr`，节拍消费见 `public/metro-engine.js` 的 `buildB`。
