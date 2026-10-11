# ScoreFollow improvement task

## Goal
Make one narrowly scoped, evidence-based improvement to the performance-analysis module without broad refactoring.

## Scope
- Project: /home/user/scorefollow
- Allowed source paths: app/PerformancePanel.tsx, lib/analysis-guard.ts, analysis_service/ only if tests require it.
- Allowed test/docs: analysis_service/test_*.py, scripts/analysis-guard-regression.mjs, /home/user/Agents/Giz/scorefollow_development_record.md

## Required investigation
1. Inspect current git diff first. Do not overwrite unrelated user changes.
2. Run the existing relevant tests before editing.
3. Identify a concrete defect affecting performance analysis UX, data integrity, or maintainability.

## Acceptance criteria
- Implement only a small, high-confidence fix supported by code/tests.
- Add or update a regression test when the defect is testable.
- Run: npx tsc --noEmit; npm run analysis-guard; npm run analysis-test.
- Do not claim browser validation unless it is actually performed.
- Report exact files changed and commands/results.

## Negative list
- No dependencies.
- No package/config rewrites.
- No broad component split or speculative redesign.
- Do not modify tsconfig.json; it contains a pre-existing unrelated diff.
- Do not touch .env, .git, generated .next files, or unrelated scripts.

## Completion signal
Write /home/user/Agents/Giz/inbox/scorefollow_improvement_handshake.json atomically with JSON fields: task, status, files_changed, tests, evidence, remaining_issues.
