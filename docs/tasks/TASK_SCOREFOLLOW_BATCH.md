# ScoreFollow batch improvement

## Goal
Ship a focused batch of improvements without changing existing shortcut semantics:
1. Make score loading/recognition status explicit and machine-testable.
2. Add real Playwright regression coverage for existing keyboard shortcuts using public/chopin.pdf.
3. Keep tuner permission UX from the previous change intact.

## Allowed files
- app/page.tsx
- app/page.module.css only if needed for a small loading-status presentation
- tests/keyboard-shortcuts.spec.ts (new)
- tests/score-load-status.spec.ts (new)
- scripts/score-load-status-regression.mjs (new, if useful)
- /home/user/Agents/Giz/scorefollow_batch_development_record.md
- /home/user/Agents/Giz/scorefollow_test_report_v4.md
- /home/user/Agents/Giz/inbox/scorefollow_batch_done.json

## Required behavior
- Preserve all existing shortcut meanings. Do not add or remove shortcuts.
- Add a stable status phase attribute or data-testid near the existing aria-live status, with phases at least: ready, loading, recognizing, ready-score, error.
- Set phase consistently for PDF/image/preload success, recognition progress and errors; initial empty state must be ready/empty or equivalent and must not claim a score is loaded.
- Keep the actual status text bilingual/compatible with current lang behavior.
- Use public/chopin.pdf in browser tests; no mock score.
- Keyboard tests must prove actual UI/state effects, not just key dispatch: H opens help, Escape closes it, Space toggles metronome state, PageDown/PageUp changes page when multiple pages exist, +/- changes speed display/control when applicable. If a shortcut is unavailable in a given fixture, record an evidence-based skip rather than inventing success.

## Negative list
- No new dependencies.
- Do not modify package.json/package-lock.json, tsconfig.json, analysis state machine, tuner logic, or shortcut meanings.
- Do not delete existing untracked test artifacts.
- Do not claim a shortcut works from source inspection alone.

## Acceptance
- npx tsc --noEmit
- npm run build
- existing node regressions: analysis-job, tuner-state, tuner-permission, performance-cache, analysis-guard if present
- npx playwright test tests/keyboard-shortcuts.spec.ts tests/score-load-status.spec.ts --reporter=line
- git diff --check
- Write valid JSON atomically to /home/user/Agents/Giz/inbox/scorefollow_batch_done.json with task, status, files_changed, tests, screenshots, remaining_issues.

## Worker discipline
Use batch-runner omega_batch for deterministic command groups when available. Keep output bounded. Do not modify files outside the allowed list.
