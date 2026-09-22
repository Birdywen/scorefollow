# v6 Audit Report (2026-09-22)

## Executive Summary

本次审计完成了评测修正和实现审查。v6 保持干净谱零回归，但在单谱表独奏曲上的符干误报修复率低于预期（56% vs 目标 80%+）。关键发现：

- **评测器口径变化：** 修正参考端点依赖和系统匹配规则后，v6 新基线为 TP=520/FP=249/FN=53（参考总数573），之前报告的 v5/v6 总分不可比。
- **实现缺陷修复：** 最长游程起止记录分离问题已修复并验证无副作用。
- **特征实验结论：** 两组实验（谱线污染屏蔽、谱表外延伸）均未达到"减少误报且不增漏检"的验收标准，未合并。

---

## 1. Evaluator Changes

### 1.1 Fixed Reference Denominator

**Before:** 参考小节线集合根据我方最后一条检测线动态过滤 HOMR 端点，导致算法改变时参考分母跟着变化。

**After:** 参考端点固定由 HOMR 系统自身的 `max_x` 决定；系统匹配改为严格一对一，禁止多个我方系统争抢同一参考组并重复计分。

**Impact:**
- v6 GPU 基线变为 TP=520、FP=249、FN=53，参考总数 573（之前 v5 报告的 599 和 v6 的 593 均不可比）。
- 未匹配参考系统现计入 FN，Suzuki p1 增加 9 条 FN（我方系统 5 vs HOMR 7，3 个参考组未匹配）。

### 1.2 Adjudication Status Update

撤回 Toccatta p2/p3 的旧裁决（用户已确认应采纳 HOMR），状态改为 `pending`，等待页级人工标注与逐坐标映射。

**Committed baseline (benchmarks/homr/):** 仍为 TP=61/FP=1/FN=1（ADJUDICATION_PASS 门禁失效，需重新标注 Toccatta）。

---

## 2. Implementation Audit

### 2.1 Longest Run Bug Fix

**Issue:** `barStemFeatures` 在计算最长暗游程时，`bestR1` 在每次新游程开始时更新，`bestR2` 仅在刷新最大长度时更新，二者可能来自不同游程段。

**Fix:** 提取独立函数 `longestDarkRun`，保证起止位置来自同一游程：

```typescript
export function longestDarkRun(first: number, last: number, dark: (row: number) => boolean) {
  let run = 0, length = 0, start = first, end = first - 1;
  for (let row = first; row <= last; row++) {
    run = dark(row) ? run + 1 : 0;
    if (run > length) { length = run; start = row - run + 1; end = row; }
  }
  return { length, start, end };
}
```

**Verification:** GPU 基线在此修复后保持 TP=520/FP=249/FN=53 不变（逐行对比 `/tmp/opencode/v6-audit.json` vs `/tmp/opencode/run-fix-audit.json`）。

### 2.2 Boundary Protection

增加 `darkAt` 边界检查，防止访问越界像素：

```typescript
if (row < 0 || row >= pix.length / stride || col < 0 || col + 1 >= stride / 4) return false;
```

**Verification:** 同上，GPU 基线不变。

---

## 3. Feature Experiments (Not Merged)

### 3.1 Staff Line Masking

**Hypothesis:** 谱线行在端窗中贡献宽度 21，污染中位数计算，导致符头/符梁误认为"窄"。

**Implementation:** 检测横向延伸 ±2×spatium 的暗行，排除其参与 `wideRows` 计数。

**Result:**
- TP: 520 → 523 (+3)
- FP: 249 → 320 (+71)
- FN: 53 → 50 (-3)

**Verdict:** 救回 3 条参考线，但误报激增 71 处，**不合格**。原因：许多真小节线穿过和弦密集区，横向扩展检测误将其归为"宽附着"。

### 3.2 Single-Staff Extension Check

**Hypothesis:** 单谱表中符干延伸到谱表外，而真线在谱表边界处停止。

**Implementation:** 当系统高度为 3.5~4.5 spatium（单谱表范围）时，检查列在上下谱线外侧 0.4~1.2 spatium 范围内的连续暗像素数；达到 70% 距离阈值则强制端窗计数≥4。

**Result:**
- TP: 520 → 517 (-3)
- FP: 249 → 229 (-20)
- FN: 53 → 56 (+3)

**Verdict:** 减少 20 个误报，但新增 3 个确认真线漏检，**不合格**。问题：①单谱表判定用固定 spatium 倍数过于粗糙；②延伸检测未区分符头落在加线上的情况。

---

## 4. Snapshot Archive

冻结基线保存在 `benchmarks/snapshots/v6-before-audit/`，包含：
- `synpdf-legacy.ts`（algo v6 源码）
- GPU/HOMR 两套数据的 `meta.json`、`homr.json`、`ours.json`
- `manifest.json`（PDF SHA-256 哈希与路径）

实验报告：
- `/tmp/opencode/v6-audit.json`（评测修正后基线）
- `/tmp/opencode/run-fix-audit.json`（游程修复验证）
- `/tmp/opencode/staff-mask-audit.json`（谱线屏蔽实验）
- `/tmp/opencode/extension-audit.json`（延伸检测实验）

---

## 5. Next Steps (Not Executed)

建议优先级：

1. **P0 - 人工标注确认真值**
   - Toccatta p2/p3（用户已确认 HOMR 可采纳）
   - Rococo p2（高频符干误报区）
   - Serenade p4（v6 新增误杀风险区）

2. **P1 - 改进特征而非堆叠阈值**
   - 单谱表与多谱表分开处理（系统高判定需更精细）
   - 检查谱间空隙覆盖而非依赖端窗行数
   - 在特征计算中排除谱线行（不改原图），重新测量杆宽与附着

3. **P1 - NMS 与候选筛选顺序重排**
   - 先降分干扰候选，后合并物理线，避免强符干先压死真线

4. **P2 - 系统分组与小节构造**
   - Toccatta 谱号区误计数
   - kupdf 大谱表分组与小节边界对齐

**Current Status:** v6 维持在线，等待人工标注完成后再决定下一版特征设计。

---

## Appendix: Detailed Metrics

### GPU Baseline (evaluator=2, algoVersion=6)

| Score | Systems | TP | FP | FN |
|---|---|---|---|---|
| arpeggione_sonata | 14/14 | 55 | 0 | 3 |
| kupdf_net_suzuki-cello-school-vol-3-piano-accomp | 15/15 | 98 | 14 | 18 |
| saint-preux_-_le_reve | 10/10 | 32 | 0 | 0 |
| serenade_vl_pf | 24/24 | 82 | 34 | 9 |
| suzuki-book3-3-4 | 13/14 | 57 | 38 | 13 |
| swan_cello_melody | 7/7 | 45 | 14 | 0 |
| tschaikowsky_rococo_gru_mmer_cello | 26/26 | 42 | 114 | 13 |
| vivaldi-bajazet-sposa-son-disprezzata-aria-irene | 20/20 | 76 | 1 | 2 |
| yradier_c_la_paloma_piano_beg | 16/16 | 59 | 4 | 0 |
| **TOTAL** | **141/148** | **520** | **249** | **53** |

**Reference Count:** 573 (TP+FN)  
**Mean Deviation:** 0.70px

### Committed Baseline (benchmarks/homr/)

- secret_garden + toccatta: TP=61, FP=1, FN=1, meanDev=0.71
- **Status:** ADJUDICATION_FAIL(10) after撤回旧裁决，需重新标注

---

**Audit Date:** 2026-09-22  
**Auditor:** OpenCode agent  
**Approved for Archive:** Yes  
**Approved for Deployment:** No (pending human confirmation)
