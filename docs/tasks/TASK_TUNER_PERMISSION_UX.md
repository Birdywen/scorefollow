# ScoreFollow tuner permission UX

## Goal
Improve the user-facing tuner microphone failure message without changing pitch detection or state-machine behavior.

## Allowed files
- app/hooks/useTuner.ts
- app/TunerPanel.tsx
- scripts/tuner-permission-regression.mjs
- /home/user/Agents/Giz/scorefollow_correction_record.md

## Required behavior
- Preserve the original error internally for debugging where practical.
- Map common getUserMedia failures to clear bilingual messages:
  - NotAllowedError / PermissionDeniedError: microphone permission denied; explain browser/site permission and offer upload alternative.
  - NotFoundError / devices absent: no microphone found.
  - NotReadableError / TrackStartError: microphone is busy or unavailable.
  - insecure context / unsupported API: microphone unavailable on this page; use HTTPS/localhost or upload audio.
  - unknown errors: retain a safe bilingual fallback including the original message.
- Do not modify MIN_HZ, MAX_HZ, IN_TUNE_CENTS, pitch detection, reducer transitions, or UI layout.
- Keep the existing onError callback contract as a string.
- Add deterministic regression assertions for error mapping; no browser/device mock required.

## Negative list
- No new dependencies.
- Do not modify tsconfig.json, package.json, PerformancePanel, analysis state machine, shortcuts, or PDF logic.
- Do not claim a real microphone is available.

## Acceptance
- npx tsc --noEmit
- node scripts/tuner-permission-regression.mjs outputs TUNER_PERMISSION_REGRESSION_PASS
- node scripts/tuner-state-regression.mjs
- npm run build
- git diff --check
- write /home/user/Agents/Giz/inbox/tuner_permission_ux_done.json with task, status, files_changed, tests, remaining_issues.
