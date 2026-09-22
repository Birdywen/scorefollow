# HOMR 交叉验证数据

## 内容
- `demo/`、`secret_garden/`、`toccatta/`：每谱 `meta.json`（渲染尺寸）、`homr.json`
  （HOMR bbox，去 musicxml）、`ours.json`（我方检出，algo 版本见内）、`page_N.png` / `page_N.raw`（宽 1000 渲染）。
- `adjudicated.json`：人工仲裁结论（宽 1000 坐标）。
- overlay / `z_*` 裁图：仲裁过程图，不提交（gitignore），再生见下。

## 再生
- 渲染 + 拉取：`homr/.venv/bin/python scripts/homr-data.py`（需本机 :8000 HOMR 服务）。
- 我方检出：`node scripts/homr-dump.mjs`。对比：`node scripts/homr-compare.mjs`（含仲裁门禁）。
- overlay：`homr/.venv/bin/python scripts/homr-overlay.py <谱> <页>`（红=我方，蓝=HOMR）。

## 记分牌（algo v5，2026-09-21）
- 24/24 系统配对成功，内部小节线 tp=61，meanDev 0.71px（跨引擎口径差：HOMR 报框中心，我方报左缘）。
- 2 处分歧经放大图仲裁，均为 HOMR 错误：p2sys1 x=167 符干误报、p3sys5 x=705 Coda 起始线漏报。仲裁后我方 7 页全对。

## 小节数对照（口径说明）
| 谱 | 我方（印刷顺序几何小节） | HOMR musicxml（逻辑小节） | 结论 |
|---|---|---|---|
| SG p1/p2 | 20 / 18 | 20 / 18 | 一致 |
| Toccatta p1 | 13 | 13 | 一致 |
| Toccatta p2 | 16 | 15 | 差 1：1st ending 口径差 |
| Toccatta p3 | 19 | 17 | 差 2：2nd ending + D.S./Coda 口径差 |

- 使用姿势：`bar_lines`/`staffs` 互验（强信号）；`notes` 框为 HOMR 强项、我方盲区，留作音符级工作真值；
  `musicxml measures` 只参考不采信（反复/Coda 谱上印刷序与逻辑小节天然对不上）。
- 注意：`demo/` 与 `secret_garden/` 经 md5 确认为同一文件，benchmark 以后两者（5 页）为准。
