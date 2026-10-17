# 演奏分析进度交接（ANALYSIS-HANDOFF）

> 换人或换对话时从这里接手。内容冲突时以代码和测试为准，其次是 `docs/plans/PERFORMANCE-ANALYSIS-PLAN.md`，最后才是本文件。`docs/HANDOFF.md` 是 2026-09-21 重建阶段的历史交接记录。

更新：2026-10-17

## 当前交接（2026-10-17）

### 代码与发布状态

- 当前工作目录：`/home/ubuntu/n/scorefollow-deploy`，`main`。本次更新文档前工作树干净，与 `origin/main` 同步。
- 最新功能提交：`f5c4ece06d4618e73bc39af42ead908108831a6e`（OCR 大窗口预览），已提交、推送；远端 HEAD 已核对。提交/推送 job：`job-mvbcec36-1b569586`，2/2 PASS。
- **正式站尚未完成发布**：`https://ezmusicstore.com/scorefollow/` 的发布入口在 ezmusics/cPanel 主机：`~/scorefollow/deploy.sh`。本机无该脚本、无 SSH config；本轮未执行正式站发布，也未验证正式站新版。
- **公网测试站也未加载新版**：`http://150.136.51.61/scorefollow/` 的 Nginx alias 指向 `/home/ubuntu/n/scorefollow/out/`，不是本次工作目录。资源对照 job `job-mvbceo93-e2951fea` 第一步 FAIL（页面引用的脚本与本次构建不一致），第二步浏览器验收被 halted，不能报上线。
- `/home/ubuntu/n/scorefollow` 当时在 `fix/crepe-batch-verdicts`，有未提交的分析服务改动及 CREPE 文件。不得直接 pull、切分支或覆盖；先核对并保留这些工作。
- 新版静态产物在本次工作目录的 `out/`、`out-root/`；本地验证副本 `/tmp/opencode/scorefollow/` 已更新。产物及测试副本更新不等于公网发布。

### OCR 预览：本轮已完成

- `app/PerformancePanel.tsx`：OCR 结果入口改为打开 `ScorePreviewDialog`；下载名优先使用实际识别的 PDF 文件名。
- `app/ScorePreviewDialog.tsx`：大尺寸原生模态窗口，60%–200% 缩放、-12 至 +12 半音移调、当前版本 MusicXML 下载；中英双语、Tab 循环、Esc 关闭、关闭后焦点返回。
- `app/ScoreOsmdPreview.tsx`：通过 OSMD Zoom 渲染；渲染错误后保留容器以便重试。
- `lib/score-transpose.ts`：当前为音符整体半音移调，**保留原调号**；仅影响预览与下载，不替换分析目标谱。休止符和无固定音高音符不移调。
- `scripts/verify-score-preview.mjs`：从真实页面 OCR 入口测试，拦截 OCR 请求返回固定 MusicXML；不代表重新验证了 OCR 服务识别准确率。断言大窗口尺寸、焦点、缩放、下载文件名及实际音高、Esc/焦点返回。
- 最新验收 job `job-mvbc8j8h-11a342c1`：4/4 PASS。根路径构建及浏览器验证、生产 basePath 构建及类型检查、生产 basePath 浏览器验证及 diff 检查全部通过；两种构建均测 1280px / 390px。
- 截图：`/tmp/opencode/score-preview-1280.png`、`/tmp/opencode/score-preview-390.png`。临时 `app/preview-test/page.tsx` 与 `scripts/preview-verify-tmp.mjs` 已从源码删除。
- 测试排障记录：下载按钮的 accessible name 是 `Download the previewed MusicXML`；旧测试按可见短文案定位导致超时。Snap Chromium 下载目录须可被浏览器与 Node 同时访问；harness 默认使用 `~/snap/chromium/common/score-preview-downloads`，可用 `SF_DOWNLOADS_PATH` 覆盖。

### 此前已完成与仍待处理

- 分析 0.23：`35fb4b7`，pYIN-first，BP 只在救援轮启用；既有精度约束保持。clean 基线提交 `f83b7db`：无 BP 30 clips / scored 23，pitch 中位 99.0、rhythm 94.0；对 0.20 回归门通过。用户本轮反馈实际对齐准确率很高。
- UI 散点降载/拆文件：`9684708`。
- E14 小节线修复：`fcfbd93`，`ALGO_VERSION=33`，3 FN 救回（314→313、156、140→138），两处漂移恢复（427→411、702→685）；当时 GT 重放 696/16/6 无变化，tsc/regression/synth 通过。
- E14 sys7/x382 误检仍保留；staff 的 -16 是裁边坐标帧差，不是检测回归。不要直接把用户导出的 cs 当分析帧坐标使用。
- 重复句定位失败等分析未决项仍在：no01/no10/no15/no20/no25s0/no26/no28/no33s1；需要手动起始小节。no25 slow 的低分曾判为真实拉错，不应为抬分改门槛。
- 语料使用 `/tmp/opencode/corpus-data`；旧 `~/n/scorefollow/datasets/dotzauer-op113` 的 No07 XML 过期。

### 下一接手者

1. 在 ezmusics/cPanel 执行 `~/scorefollow/deploy.sh`，确认拉到 `f5c4ece` 或其后包含该功能的提交。
2. 正式站核对实际加载的资源及 OCR 大窗/缩放/下载/关闭行为；可设置 `SF_UI_URL=https://ezmusicstore.com/scorefollow/` 运行上述 harness（OCR 响应仍是固定夹具）。
3. 若要更新 Oracle 公网测试站，先处理上述目录/分支分歧并保护未提交工作，再走明确发布流程；不要把本地 8901 验证当成公网验收。
4. 本轮仅前端改动，无需为此重启分析服务；小节线 v33 也属于前端检测逻辑。

---

## 历史记录（2026-10-02；以下工作目录、测试数和发布状态不再作为当前验收条件）

## 目标

优化单声部演奏分析引擎（`analysis_service`）的音高、节奏评分准确性与性能。每项改动都带回归测试，并写入开发记录。

## 接手前先核对

全部符合才能信本文件，否则以实际状态为准：

- `git log -1 --format=%s` 是更新本文件的提交，或者比它更晚。
- `git status --porcelain` 为空；`analysis-opt` 与 `main` 同步（`git rev-list --count main...analysis-opt` 为 0）。
- `python3 -B -m unittest discover -s analysis_service -t .` 输出 71 tests，`OK (skipped=1)`。
- `systemctl is-active scorefollow-analysis` 输出 `active`。

## 工作约定

- 服务目录 `~/n/scorefollow`（`main`）不直接改。在 worktree `~/n/scorefollow-opt`（`analysis-opt`）里改，再快进合并到 `main`。
- 流程：先写失败测试，再改代码，然后跑全量 analysis-test。每项单独提交，提交说明写清原因和证据，最后写入 `PERFORMANCE-ANALYSIS-PLAN.md`「开发记录（分支 analysis-opt）」，进度变化时同步本文件。
- 开发记录分两节：完成的条目插在「已完成：」下，没做完的插在「未决：」下。
- 前端有改动时，合并后另跑 `npx tsc --noEmit` 和 `npm run build`。
- 合并、push、重启服务前先征得负责人同意。正式站部署由负责人在 cPanel 跑 `~/scorefollow/deploy.sh`。

## 已完成（均已在 main）

| 提交 | 内容 | 证据 / 回归 |
|---|---|---|
| `bee4fe8` | vamp-beat 休止开头相位 | |
| `cc0c8ad` | 拍点单位不是四分音符时退回 legacy，并标 `tempoMismatch` | |
| `d575f1a` | 速度漂移跟随 | |
| `9eaeffb` | 报告摘要显示 `tempoMismatch`（录音面板不显示，产品决定） | |
| `9fe1776` | #11 半音连奏起音 | `test_semitone_legato_onsets_are_detected` |
| `bb9df83` | 稳定地慢只扣准确度 | `test_steady_slow_tempo_costs_accuracy_not_stability` |
| `9dd8916` | #5 宽窗匹配大幅节奏偏差 | ±300 ms 时可判起音 0 → 4 |
| `a29e28d` | #6 录音电平归一化 | 峰值 0.012 原报“无法检测到演奏”，修复后正常 |
| `33563a0` | #7 pYIN 音高提示全路径校验，段间不填邻音 | 漏奏音由 +200 音分错音改判不确定，音高分 75 → 99 |
| `886d295` | #8 `track()` 分块批量 FFT | 300 s/48 kHz 10.19 → 5.41 s，最大差 0.0036 音分 |
| `d4b0509` | #9 准确度改用截断均值（250 ms） | 单音 +400 ms 时 95 → 70 |
| `1741b2a` | 开发记录拆分「已完成」/「未决」 | 仅文档 |

#10 结论（不改）：`notes[].measure` 是小节序号，前端 PDF 跳转依赖它，并要求 `pdfMeasures === measureCount`。

## 未决

- 方案 B：拍点按倍速、半速、附点自动换算。需要真实标注录音（起始小节、实际 BPM、拍点单位）。
- vamp-beat 加指定起始小节时，音符时长仍按面板 BPM 计算，随方案 B 一起处理。
- 正式站是否已部署到 `d4b0509`：未确认（之后只有文档改动）。

## 下一步

1. 确认正式站部署状态。
2. 拿到标注录音后：先定标注集格式并写导入脚本，用现有算法跑出基线，再做方案 B。

## 相关文件

- `analysis_service/engine.py`（`track` / `_hint_track` / `analyze`）
- `analysis_service/alignment.py`（`usable_events` / `locate_excerpt`）
- `analysis_service/vamp_features.py`、`analysis_service/server.py`、`analysis_service/test_engine.py`
- `app/PerformancePanel.tsx`
- `PERFORMANCE-ANALYSIS-PLAN.md`「开发记录（分支 analysis-opt）」
