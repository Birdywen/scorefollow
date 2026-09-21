# ScoreFollow 识别基准集

## 当前状态
- 合成回归: `npm run regression` (纯函数, 无需浏览器/PDF)
- 真谱抽查: `public/demo-score.pdf` + Secret Garden(外部谱, 见 HANDOFF)
- 目标 12 份 PDF 全覆盖前, 每次算法改动至少跑合成回归 + `tsc` + `build`

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
