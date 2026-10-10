# ScoreFollow panel state correction

## Goal
Correct the no-score-loaded state introduced by the cache/panel task.

## Required change
In app/PerformancePanel.tsx, do not treat pdfName alone as proof that a score is loaded. The no-score guidance must appear on the actual initial page state observed by the browser, while disappearing once a real PDF/MusicXML is loaded.

Use only reliable existing state/props (for example pdfMeasures, pdfBytes(), and xmlFile) and avoid adding dependencies or broad refactors.

## Allowed files
- app/PerformancePanel.tsx
- scripts/performance-cache-regression.mjs
- /home/user/Agents/Giz/inbox/scorefollow_optimization_handshake.json

## Acceptance
- Existing cache behavior remains unchanged.
- Add/update deterministic regression assertion for the corrected state condition.
- Run npx tsc --noEmit, npm run build, npm run analysis-guard, node scripts/performance-cache-regression.mjs, git diff --check.
- Do not modify tsconfig.json or unrelated files.
- Write the handshake JSON atomically with task scorefollow_panel_state_correction.
