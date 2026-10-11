# ScoreFollow: declare analysis deps and surface vamp degradation

## Goal
1. Declare the analysis service Python dependencies so the test env is reproducible.
2. Make optional-plugin degradation explicit in the analysis result instead of logs only.

## Allowed files
- analysis_service/requirements.txt (new)
- analysis_service/vamp_features.py
- analysis_service/server.py
- analysis_service/engine.py only if strictly required
- analysis_service/test_vamp_degraded.py (new)
- analysis_service/VAMP_SETUP.md

## Requirements
- requirements.txt must list required runtime deps actually imported by analysis_service (including mido) and mark vamp as optional with a comment.
- Expose degradation in the job result payload: add fields such as engine/sensors already present plus a clear boolean and reasons, e.g. result['summary']['degraded'] (bool) and result['summary']['degradedReasons'] (list of short strings like 'pitch:builtin', 'onset:builtin', 'beat:legacy').
- Degradation must be derived from real detector availability at run time, not hardcoded true.
- When vamp is available and used, degraded must be false and reasons empty.
- Do not change scoring math, thresholds, or existing public field names.
- Keep backward compatibility: existing keys must remain.
- Add unittest coverage in analysis_service/test_vamp_degraded.py proving: degraded true + reasons when vamp import fails; degraded false when detectors return values.

## Negative list
- No new third-party dependency beyond what is already imported.
- Do not modify package.json, tsconfig.json, app/, lib/, scripts/, tests/.
- Do not install system packages.
- Do not weaken or skip existing tests.

## Acceptance
- npm run analysis-test passes with no errors.
- python3 -m unittest analysis_service.test_vamp_degraded -v passes.
- git diff --check clean.
- Write /home/user/Agents/Giz/inbox/vamp_degraded_done.json atomically with task, status, files_changed, tests, remaining_issues.

Use batch-runner omega_batch for deterministic command groups. Keep output bounded.
