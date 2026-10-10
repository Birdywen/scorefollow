# 演奏分析进度交接（ANALYSIS-HANDOFF）

> 换人或换对话时从这里接手。内容冲突时以代码和测试为准，其次是 `PERFORMANCE-ANALYSIS-PLAN.md`，最后才是本文件。仓库根目录的 `HANDOFF.md` 是 2026-09-21 重建阶段的交接记录，与本文件无关。

更新：2026-10-02

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
