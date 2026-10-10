# ScoreFollow cache and panel optimization task

## Goal
Improve the performance-analysis panel with two narrowly scoped, testable changes:
1. Prevent duplicate analysis submissions for the same take and analysis inputs during the current browser session, and reuse a completed result when the exact input signature matches.
2. Make the no-score-loaded state explicit in the panel so disabled analysis actions explain that a score/PDF must be loaded first.

## Allowed paths
- app/PerformancePanel.tsx
- app/performance.module.css only if needed for the state message
- scripts/performance-report-browser.mjs or a new scripts/performance-cache-regression.mjs
- /home/user/Agents/Giz/scorefollow/inbox/scorefollow_optimization_handshake.json

## Must inspect first
- Preserve existing unrelated changes, especially tsconfig.json.
- Run the relevant existing browser/regression test before editing if available.

## Cache requirements
- Cache must be in-memory/session scoped, not persistent localStorage, and must not cache raw audio blobs.
- Signature must include the MusicXML content, audio/take identity or audio bytes identity, instrument, BPM, start measure, sync mode and relevant sync data.
- Do not reuse a result across different inputs or analysis settings.
- Duplicate in-flight analysis for the same signature must not submit another POST /jobs.
- A completed cached result must update the selected take exactly as a fresh result would.
- Cache failures; failed results must not be treated as completed cache hits.
- Keep the change small and document the invalidation scope in code.

## Panel requirements
- When no score/PDF is loaded, show an accessible status/instruction near the analysis controls explaining that the user must load a score first.
- Do not falsely claim that recording or analysis is available.
- Preserve existing functionality when a score is loaded.

## Acceptance criteria
- No new dependencies.
- No package/config rewrites.
- No broad component split.
- Add a deterministic regression test or extend the existing browser test to prove duplicate submission prevention/cache hit and no-score guidance.
- Run independently after editing:
  - npx tsc --noEmit
  - npm run build
  - npm run analysis-guard
  - the new or updated focused regression test
  - git diff --check
- Do not modify tsconfig.json or unrelated files.

## Completion signal
Atomically write /home/user/Agents/Giz/inbox/scorefollow_optimization_handshake.json with JSON fields:
{"task":"scorefollow_cache_panel","status":"completed|failed","files_changed":[],"tests":[],"evidence":[],"remaining_issues":[]}
