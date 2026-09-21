# HANDOFF · scorefollow 重建 (2026-09-21, Phase 2.1 full port)

远端 `/home/user/agi-watch/scorefollow` 丢失, 按本地残件重建于 `/home/ubuntu/n/scorefollow`。
路线: 全量 TypeScript 移植 + GPL 复用 vendor (用户 2026-09-21 裁决)。

## 残件→重建映射
- `_vendor/` ← `scorefollow-rebuild/synpdf_194.zip` (7 文件, synpdf.js md5 957597b8, 三份一致已验)
- `lib/synpdf-legacy.ts` ← synpdf.js rev.194 算法直译 (drawRes/countPix/countVsys/findBarLines)
  + 修残件 bug: 裸 `skipn` → skipnV, 未声明 `annot_fontpx` → annotFontPx,
  + TS evolving-any: countVsys 尾部聚类段改写为具名变量 (语义与原版 `d & h-b>c-h` 一致)
  + 导出: legacyOpt / witArr / countPix / setSkipn / setSysprf / getSpatium / getAnnotFontPx
- `lib/synpdf-core.ts` ← 门面: 类型重导出 + PageAnalysis + 页缓存 + analyzePage
- `lib/synpdf-wijzer.ts` ← Wijzer 移植: buildMeasures(knip→deMaten) / time2x / x2time / goMsre / tap / loadTimes / A-B loop
- `app/page.tsx` ← 按 p9 补丁蓝图: PDF 上传→pdfjs 渲染→分析覆盖层(SVG 系统框/小节线)→advanced 12 参数→媒体(audio/video)→rAF 跟随→count-in→TAP→点谱 seek→键盘
- `app/api/health` ← pm2/tunnel 探针
- `public/pdf.worker.min.mjs` ← pdfjs-dist 6.3.289 (workerSrc, 避开打包 worker 坑)

## 验证 (2026-09-21)
- `npx tsc --noEmit` clean; `npm run build` green (Next 16.3.5)
- 合成谱 node 实测 CORE_TEST_PASS: 2 系统 y 52..92/152..192, spatium 10.0, 小节线 20/139/259/379,
  Wijzer 6 小节, cursor/seek/goMsre/loop 全对
- pm2 scorefollow :8080 online; /api/health ok; SSR 含 advpanel + 11 advanced 参数; nginx 80 → 200
- 公网: http://150.136.51.61/

## 与原版差异 (有意)
- 端口 8080 (原 3300, 公网直出免隧道); 其余行为对齐 Phase 2.1
- preload 文件导入 (evalPreload/copyTiming) 未移植 — 如需 synpdf.html 旧同步数据, 下一步补
- mixer 多轨 / Dropbox / YouTube / WS 同步未移植 (原版 synpdf.js 有, Phase 2.1 远端也没有)

## 下一步候选
1. 真谱端到端: 用 livescore scores/secret_garden_adagio/score.pdf 上传验框
2. preload 导入 + timing JSON 存取 (TAP 建图已可导出扩展)
3. mixer 多轨 (mixer_in.js 残件现成)
