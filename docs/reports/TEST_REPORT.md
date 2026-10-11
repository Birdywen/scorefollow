# ScoreFollow 真实乐谱测试报告

**测试时间**: 2026-10-09 21:05–21:12 UTC
**测试文件**: chopin.pdf
**测试环境**: Node.js v24.21.0、npm 11.19.0、Playwright 1.64.0、Chrome 155.0.8059.39

---

## 测试执行摘要

| 测试场景 | 状态 | 备注 |
|---------|------|------|
| 文件加载 | ✅ | 2 页 / 11 行 / 57 小节，canvas 正常渲染 |
| 节拍器 | ✅ | ▶ 节拍器 ⇄ ■ 停止 切换正常，可二次切回 |
| 翻页控制 | ✅ | 第 1/2 页 → 第 2/2 页 → 切回第 1 页；首末页禁用态正确 |
| 调音器 | ✅ | 面板打开/显示/关闭正常；无麦克风时报错但不崩溃 |
| 设置面板 | ✅ | loop A-B / count-in / sync / panel / correct 等设置项齐全 |
| 状态一致性 | ✅ | 快速连续操作后谱面不丢失，零未捕获异常 |

**通过率**: 6/6 (100%)

---

## 详细测试结果

测试脚本：`tests/e2e-real-score.spec.ts`（Playwright，`test.describe.serial`，共 6 个 test），配置见 `playwright.config.ts`（复用已运行的 `npm run dev` + 系统 Chrome `/opt/giz/managed/bin/google-chrome-stable --no-sandbox`）。每个场景均使用**真实** `public/chopin.pdf`，经「打开 ▾ → 载入 PDF 谱」菜单路径 + 隐藏 `input[accept=".pdf"]` 注入文件完成上传。

### 1. 文件加载流程
- **测试步骤**:
  1. 访问 `/scorefollow/`
  2. 点击"打开 ▾" → 确认"载入 PDF 谱"菜单项可见
  3. 向 `input[accept=".pdf"]` 注入 `/home/user/scorefollow/public/chopin.pdf`
  4. 等待 `#notation canvas` 出现且底部导航不再显示"等待谱面"
- **预期结果**: 谱面渲染，小节识别完成，底部显示系统/小节统计
- **实际结果**: `LOAD loadMs=788 analyzeMs=3931 canvas=2 hint=▶ 节拍器‹第 1 / 2 页›…11 行 · 57 小节 status=score: 2 pages, 11 systems, 57 measures, spatium 8.0px, algo v32`。首屏渲染出肖邦 VALSE（Alle gretto，3/4），小节序号覆盖层（蓝色 1–10）与首小节光标高亮均可见（截图 `01-pdf-loaded.png`）
- **状态**: ✅
- **截图**: `test-screenshots/01-pdf-loaded.png`

### 2. 节拍器功能
- **测试步骤**: 加载乐谱后记录主按钮文本 → 点击 → 等待 1.5s 记录文本并截图 → 再次点击 → 等待 0.8s 记录文本并截图
- **预期结果**: `▶ 节拍器` → `■ 停止` → `▶ 节拍器`
- **实际结果**: `METRO before=▶ 节拍器 during=■ 停止 toggleMs=2108`，`after=▶ 节拍器`，与预期完全一致
- **状态**: ✅
- **截图**: `test-screenshots/02-metro-before.png`、`03-metro-running.png`、`04-metro-stopped.png`

### 3. 翻页控制
- **测试步骤**: 记录初始页码指示与上一页/下一页禁用态 → 点下一页 → 断言指示变化 → 点上一页 → 断言切回
- **预期结果**: 初始`第 1 / 2 页`，上一页禁用、下一页可用；下一页后变为第 2 页；上一页后回到第 1 页
- **实际结果**: `PAGE before ind=第 1 / 2 页 prevDis=true nextDis=false` → `afterNext ind=第 2 / 2 页 switchMs=1117` → `back ind=第 1 / 2 页`，全部符合
- **状态**: ✅
- **截图**: `test-screenshots/05-page-next.png`、`06-page-prev.png`

### 4. 调音器功能
- **测试步骤**: 空谱状态点工具栏 `🎚`（`button[aria-label="调音器"]`）→ 断言 `dialog[aria-label="调音器"]` 可见且含 A4=440 文案 → 点"🎤 开始调音"（headless 无麦克风）→ 截图 → 断言面板不崩 → 点 × 关闭
- **预期结果**: 面板正常开/关；无设备时给出错误提示但面板保持
- **实际结果**: 全部通过。面板显示"拨弦或拉弓，对准绿色。A4 = 440 Hz"、-50¢/+50¢ 刻度与指针条；点击开始后显示红色 `Requested device not found`，面板保持打开（截图 `08-tuner-after-start.png`）；关闭后 `dialog` 隐藏
- **状态**: ✅（附带发现：错误文案为英文原文，见"问题 2"）
- **截图**: `test-screenshots/07-tuner-open.png`、`08-tuner-after-start.png`、`09-tuner-closed.png`

### 5. 设置面板
- **测试步骤**: 点 `button[title="设置"]`（⚙ 设置）→ 断言 `#sf-settings` 可见 → 逐项断言含 `loop`、`count-in`、`sync`、`panel`、`correct`、`full screen` → 截图 → 再次点击关闭
- **预期结果**: 面板开/关正常，设置项完整
- **实际结果**: 通过。面板另含 `圈Loop`、`? help`、`dark`、`hide UI`、loop A–B 数值输入（截图 `10-settings-open.png`）
- **状态**: ✅（附带观察：面板内英文项居多，见"改进建议 2"）
- **截图**: `test-screenshots/10-settings-open.png`、`11-settings-closed.png`

### 6. 状态一致性（快速连续操作）
- **测试步骤**: 加载乐谱后监听 `pageerror`，连续执行：下一页 → 上一页 → 节拍器开 → 0.4s → 节拍器关 → 调音器开 → 关 → 设置开 → 关 → 截图并检查 canvas 与 hint
- **预期结果**: 谱面不丢失，hint 正常，无未捕获异常
- **实际结果**: `STATE errors=0 canvas=2 hint=…11 行 · 57 小节`，通过
- **状态**: ✅
- **截图**: `test-screenshots/12-state-after-rapid.png`

---

## 发现的问题

### 问题 1: 「打开」菜单在文件选择后不会自动关闭，可能遮挡 practicebar
- **严重程度**: 中
- **复现步骤**:
  1. 点击"打开 ▾"展开 `#sf-open` 菜单
  2. 不经菜单项 onClick 而完成文件选择（程序注入 / 取消文件对话框后菜单仍展开——测试中 `setInputFiles` 即走此路径）
  3. 此时菜单浮层覆盖 practicebar 区域，点击"▶ 节拍器"被 `button[role=menuitem] "✓ 载入 PDF 谱 · chopin.pdf"` 拦截，Playwright 重试 224 次后超时（首次运行测试 2 即因此失败；加 Esc 关闭后通过）
- **预期行为**: 文件 input 变化（或文件对话框关闭）后菜单自动收起；Esc / 点击外部关闭菜单
- **实际行为**: 菜单保持展开直到再次点击"打开 ▾"
- **影响范围**: 真实用户经菜单项点击会走 `setOpenMenu(false)` 而关闭，影响较小；但取消文件对话框、拖放/程序化载入等路径会留下展开菜单遮挡操作区
- **建议修复方案**: 在 pdf/img/media/preload 四个 input 的 `onChange` 中 `setOpenMenu(false)`；给菜单加 outside-click + Esc 关闭（与 `#sf-settings` 行为对齐）

### 问题 2: 调音器麦克风错误提示未本地化
- **严重程度**: 低
- **复现步骤**:
  1. 打开调音器
  2. 在无麦克风 / 拒绝权限的环境点"🎤 开始调音"
- **预期行为**: 中文界面下显示中文友好提示（如"未找到麦克风，请检查设备与浏览器权限"）
- **实际行为**: 直接渲染浏览器英文原文 `Requested device not found`（截图 `08-tuner-after-start.png` 红色文字）
- **影响范围**: 中文用户理解成本；功能本身正常（面板不崩、可关闭）
- **建议修复方案**: 在 `useTuner` 的 `onError` / error 状态处做错误映射：`NotFoundError → 未找到麦克风`、`NotAllowedError → 麦克风权限被拒绝，请在浏览器地址栏放行后重试`，未知错误保留原文并附中文前缀

### 问题 3: 冷启动（dev 首次编译）等待时间长，期间无确定性进度
- **严重程度**: 低
- **复现步骤**:
  1. 重启 dev 服务器后首次访问并加载 chopin.pdf（测试首次运行耗时 2.3 分钟，其中绝大部分为 Next dev 编译 + 按需加载 pdfjs）
  2. 热启动后同样流程仅 `loadMs=788ms + analyzeMs=3931ms`
- **预期行为**: 用户能看到"正在加载第 x/y 页"类确定性进度，区分"编译/下载"与"识别"耗时
- **实际行为**: 应用缺陷以外的原因（dev 编译）主导了首次等待；报告如实记录以免误判为识别性能问题
- **影响范围**: 开发者/首访用户体感；生产静态构建（`out/`）不受 dev 编译影响
- **建议修复方案**: 在生产构建上复测一次并记录基线；若分析本身超过 ~5s，考虑在 `renderAndAnalyze` 循环里逐页推进 status（如 `analyzing page n/total`），当前 status 仅在完成后输出 `score: 2 pages, …`

### 问题 4: 设置面板中英文混杂（观察项）
- **严重程度**: 低
- **复现步骤**: 打开 ⚙ 设置，查看面板按钮：`count-in`、`sync`、`panel`、`correct`、`full screen`、`dark`、`hide UI` 均为英文，而周围界面为中文
- **预期行为**: 与 `STR` 双语表一致（`tx()`），中/English 切换时面板同步切换
- **实际行为**: 面板内多为英文硬编码（截图 `10-settings-open.png`）
- **影响范围**: 普通中文用户理解门槛；开发者向用户无碍
- **建议修复方案**: 将该面板按钮文案接入现有 `STR` 双语表；或明确该面板定位为"专家面板"并保留英文

---

## 性能分析

| 指标 | 数值 | 评价 |
|------|------|------|
| 页面加载（goto 到 header 可见，热） | 788ms | 快 |
| PDF 分析（2 页 / 11 系统 / 57 小节，热） | 3931ms（约 2s/页） | 中，可接受 |
| 首次冷加载（含 Next dev 编译） | 约 2.3min | 慢，但为 dev 编译开销，非应用缺陷 |
| 节拍器开/关（含测试等待） | 开 ~2.1s（含 1.5s 等待），关 <1s | 快（实际切换即时） |
| 页面切换（第 1→2 页，滚动定位） | 1117ms | 中，可接受 |
| 内存占用 | 未采集（6 轮加载/卸载无崩溃、无 canvas 丢失） | 正常（定性） |

> 说明：内存未做定量采集（Playwright 未接 CDP 采样），仅定性观察：6 个测试各做一次完整上传+识别，谱面 canvas 始终为 2 且可交互，未见泄漏导致的崩溃。

---

## 用户体验评估

### 优点
- 真实乐谱识别质量好：chopin.pdf（钢琴 Valse，3/4）识别出 11 行 57 小节，首屏谱面、小节序号覆盖层、光标高亮一次到位，无需调参
- 无音频回退设计合理：未载入音频时主按钮即节拍器开关（`▶ 节拍器`），空谱状态也有明确三步引导（载入谱面 → 检查小节 → 播放练习）+ 三个载入入口
- 无障碍基础扎实：翻页/调音器/设置按钮均有 `aria-label`/`title`，页码指示`第 1 / 2 页`清晰，首末页禁用态正确
- 对话框焦点管理到位：调音器 `role=dialog aria-modal`，Esc/× 均可关闭；帮助对话框有焦点陷阱
- 错误不崩溃：无麦克风时调音器给出红色错误并保持可用；快速连续操作零 `pageerror`

### 不足
- 「打开」菜单关闭逻辑有缺口（问题 1），取消文件对话框后菜单仍展开
- 调音器错误信息为英文原文（问题 2）
- 设置面板英文硬编码较多（问题 4）
- 分析中的进度反馈不足（问题 3）：只能看到最终 `score: 2 pages, …`，过程中不知进度

### 改进建议
1. **[菜单自动关闭]**
   - 当前状况: 文件 input `onChange` 不收菜单；取消对话框/程序化载入后菜单残留并遮挡 practicebar
   - 建议方案: 四个文件 input 的 `onChange` 末尾 `setOpenMenu(false)`；菜单容器加 pointer-outside + Esc 关闭
   - 预期收益: 消除浮层误拦截，键盘/触屏用户操作更可预测

2. **[错误文案本地化]**
   - 当前状况: `useTuner` 错误直接渲染浏览器英文原文
   - 建议方案: 按 `NotFoundError / NotAllowedError / OverconstrainedError` 映射中文友好文案，未知错误保留原文作诊断后缀
   - 预期收益: 中文用户可自行排查（接设备/放行权限），减少支持成本

3. **[分析进度反馈]**
   - 当前状况: 多页谱分析过程中 status 无逐页进度
   - 建议方案: `renderAndAnalyze` 循环中 `setStatus(analyzing page n/total)`；生产构建复测记录基线
   - 预期收益: 大谱/慢设备上用户知道"没卡死"，减少重复点击

4. **[设置面板双语]**
   - 当前状况: 面板按钮多为英文硬编码
   - 建议方案: 接入 `STR` 表随 `lang` 切换；或标注"专家面板"保留英文
   - 预期收益: 中文用户零猜测使用 loop/count-in 等功能

---

## 代码质量观察

- **组件结构**: `app/page.tsx` 约 4246 行单文件，承载渲染/分析/校正/上报全链路；本次测试未修改源码，仅从外部行为观察——功能内聚但文件偏大，后续拆分（如把菜单/对话框抽组件）可降低回归风险
- **状态管理**: `useState`（UI）+ `useRef`（分析缓存/undo 栈/引擎句柄）分层清晰；`manualRef`/`meterMapRef` 等 ref-state 双写一致，本次快速连续操作未出现状态撕裂
- **错误处理**: 调音器错误展示到位（仅缺本地化）；上报/导入链路有 `try/catch` 与用户提示；`pageerror` 零捕获说明全局异常面干净
- **类型安全**: `node_modules/.bin/tsc --noEmit` 全绿（含新增测试与配置）；`strict: true` 保持
- **测试覆盖**: 仓库已有 `regression / synth / homr / practice-sync / analysis-guard / analysis-test` 多套回归；本次新增 `tests/e2e-real-score.spec.ts` 补上真实 PDF 的端到端覆盖（6/6 通过）

---

## 下一步建议

1. **立即修复** (高优先级问题)
   - [ ] 无高优先级（P0/阻塞）问题；问题 1 评为"中"，建议随下个迭代修复

2. **短期改进** (中优先级改进)
   - [ ] 修复问题 1：文件 input `onChange` 关闭「打开」菜单 + outside-click/Esc 关闭
   - [ ] 修复问题 2：调音器麦克风错误中文映射
   - [ ] 生产构建（`npm run build` + 静态 `out/`）复测本报告流程，记录生产基线耗时

3. **长期优化** (低优先级优化)
   - [ ] 问题 3：多页分析逐页进度提示
   - [ ] 问题 4：设置面板双语化或明确专家定位
   - [ ] 性能：定量内存/长谱（如 10+ 页）压测与 CDP 采样纳入回归

---

## 附录

### 测试环境详情
- Node: v24.21.0
- npm: v11.19.0
- Playwright: v1.64.0（`@playwright/test` + `playwright-core`，`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，复用系统 Chrome）
- 浏览器: Google Chrome 155.0.8059.39 unknown（`/opt/giz/managed/bin/google-chrome-stable --no-sandbox`）
- 服务: 已运行的 `next dev`（`http://localhost:3000`，`reuseExistingServer: true`），页面路径 `/scorefollow/`
- TypeScript: `tsc --noEmit` 通过（exit 0）

### 测试文件信息
- 文件名: chopin.pdf
- 文件大小: 181020 bytes（约 177KB）
- 页数: 2 页（`pdfinfo` 确认；应用识别一致）
- 页面尺寸: 564.444 x 791.667 pts
- 内容: 肖邦 Valse（Alle gretto，3/4，KK IVb Nr. 11 体裁页），识别结果 11 systems / 57 measures / algo v32 / spatium 8.0px

### 截图列表
1. `test-screenshots/01-pdf-loaded.png` — 初始加载页面 → PDF 加载完成（VALSE 首屏 + 11 行 · 57 小节）
2. `test-screenshots/02-metro-before.png` — 节拍器启动前（▶ 节拍器）
3. `test-screenshots/03-metro-running.png` — 节拍器运行中（■ 停止）
4. `test-screenshots/04-metro-stopped.png` — 节拍器停止后（恢复 ▶ 节拍器）
5. `test-screenshots/05-page-next.png` — 下一页（第 2 / 2 页）
6. `test-screenshots/06-page-prev.png` — 上一页（切回第 1 页）
7. `test-screenshots/07-tuner-open.png` — 调音器面板（打开）
8. `test-screenshots/08-tuner-after-start.png` — 调音器点击开始后（`Requested device not found` 错误态）
9. `test-screenshots/09-tuner-closed.png` — 调音器关闭后
10. `test-screenshots/10-settings-open.png` — 设置面板（打开，含 loop/count-in/sync 等）
11. `test-screenshots/11-settings-closed.png` — 设置面板（关闭）
12. `test-screenshots/12-state-after-rapid.png` — 快速连续操作后状态

### 测试产物
- `tests/e2e-real-score.spec.ts` — Playwright 端到端测试（6 场景，真实 chopin.pdf）
- `playwright.config.ts` — Playwright 配置（系统 Chrome + 复用 dev 服务器）
- `package.json` — 新增 `devDependencies.@playwright/test@^1.64.0`（仅测试依赖，应用源码/配置零改动）
