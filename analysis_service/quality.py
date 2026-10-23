"""Evidence quality is independent of the player's score; zero is a valid score."""

import math

# Default weights; returned with every result so they can be recalibrated.
OVERALL_WEIGHTS = {"pitch": 0.5, "rhythm": 0.5}
# 0.19: 八度+极端+打分剔除音占已测音的比例达到此值, 音准证据不可靠 (partial, 不出综合分)。
PITCH_UNRELIABLE_RATIO = 0.2
# evidence-2: 速度不一致且节奏分低于此值, 视为时间映射漂移 (partial, 不出综合分)。
TEMPO_RHYTHM_FLOOR = 60
# evidence-3: 钢琴谱面检查拒评 (scoreCheck refused) -> issue score_unreliable; 两项都拒评时 outcome score_unreliable。
# evidence-4: 唯一挡住综合分的是 low_coverage 且覆盖只是略低 (听清 >= REFERENCE_HEARD_FLOOR,
# 音高可判 >= REFERENCE_PITCH_FLOOR) 时仍给综合分, 标 overallReliability "reference" + unheardRatio。
REFERENCE_HEARD_FLOOR = 0.6
REFERENCE_PITCH_FLOOR = 0.5
QUALITY_VERSION = "evidence-4"


def assess_quality(result: dict) -> dict:
    summary = result["summary"]
    count = summary.get("noteCount", 0)
    pitch_coverage = min(1.0, summary.get("scoredPitchNotes", summary.get("voicedNotes", 0)) / count) if count else 0.0
    candidates = summary.get("timingCandidateNotes", max(0, count - 1))
    timing_coverage = min(1.0, summary.get("timedNotes", 0) / candidates) if candidates else 0.0
    scores = sum(summary.get(key) is not None for key in ("pitchScore", "rhythmScore"))
    issues = []
    if summary.get("syncAdvice"):
        issues.append("alignment_unverified")
    reasons = summary.get("degradedReasons")
    grid_rejected = isinstance(reasons, list) and "beat:rejected" in reasons
    # A rejected beat grid is a score/take mismatch, not a missing detector.
    if summary.get("degraded") and not (grid_rejected and all(r == "beat:rejected" for r in reasons)):
        issues.append("builtin_detectors")
    if grid_rejected:
        issues.append("beat_grid_rejected")
    if summary.get("clipped"):
        issues.append("clipped_audio")
    if summary.get("confidence") == "low" or pitch_coverage < .6:
        issues.append("low_coverage")
    if summary.get("tempoMismatch"):
        issues.append("tempo_mismatch")
        rhythm_now = summary.get("rhythmScore")
        if rhythm_now is not None and rhythm_now < TEMPO_RHYTHM_FLOOR:
            issues.append("tempo_timing_unreliable")
    check = summary.get("scoreCheck") or {}
    # Piano: the score itself was found unreliable for pitch and/or rhythm (evidence in scoreCheck).
    if "refused" in (check.get("pitch"), check.get("rhythm")):
        issues.append("score_unreliable")
    if summary.get("takeBeyondScoreAfterSec") is not None:
        issues.append("take_beyond_score")
    measured = summary.get("voicedNotes") or 0
    unreliable = sum(summary.get(k) or 0 for k in ("outlierNotes", "octaveUncertainNotes", "excludedPitchNotes"))
    if measured and unreliable / measured >= PITCH_UNRELIABLE_RATIO:
        issues.append("pitch_tracking_unreliable")
    # Score/take mismatch: most scorable notes miss the score pitch AND the
    # timeline is unverified and was not rescued. A verified timeline with many
    # wrong notes is a poor performance and stays scored. Thresholds from
    # replay probes (mismatch <= .35, real or poor takes >= .72).
    scored = summary.get("scoredPitchNotes") or 0
    correct = summary.get("correctPitchNotes")
    match_rate = round(correct / scored, 3) if correct is not None and scored >= 12 else None
    unverified = bool(summary.get("syncAdvice")) or summary.get("pitchScore") is None or "low_coverage" in issues
    mismatch = match_rate is not None and match_rate < .4 and unverified and not summary.get("autoMeasureSync")
    if mismatch:
        issues.append("score_audio_mismatch")
    if not scores and "score_unreliable" in issues:
        outcome = "score_unreliable"
    elif not scores:
        outcome = "insufficient_evidence"
    elif mismatch:
        outcome = "score_audio_mismatch"
    elif scores < 2 or "alignment_unverified" in issues or "low_coverage" in issues or \
            "pitch_tracking_unreliable" in issues or "tempo_timing_unreliable" in issues or \
            "range" in (summary.get("rescueReasons") or []):
        outcome = "partial"
    elif summary.get("autoMeasureSync"):
        outcome = "complete_with_rescue"
    else:
        outcome = "complete"
    intervals = result.get("measureIntervals") or []
    valid_timeline = len(intervals) >= 2 and all(
        item["endSec"] > item["startSec"] >= 0 and
        (i == 0 or item["measure"] > intervals[i - 1]["measure"] and
         item["startSec"] >= intervals[i - 1]["endSec"] - .001)
        for i, item in enumerate(intervals))
    # Combined score only when both components exist on a verified, covered
    # timeline; never back-filled for old or incomplete reports.
    pitch, rhythm = summary.get("pitchScore"), summary.get("rhythmScore")
    weights = dict(OVERALL_WEIGHTS)
    overall, reliability = None, None
    heard = min(1.0, (summary.get("voicedNotes") or 0) / count) if count else 0.0
    borderline = heard >= REFERENCE_HEARD_FLOOR and pitch_coverage >= REFERENCE_PITCH_FLOOR and not mismatch
    if pitch is not None and rhythm is not None and "alignment_unverified" not in issues \
            and ("low_coverage" not in issues or borderline) \
            and "pitch_tracking_unreliable" not in issues and "tempo_timing_unreliable" not in issues:
        overall = int(math.floor(pitch * weights["pitch"] + rhythm * weights["rhythm"] + .5))
        reliability = "reference" if "low_coverage" in issues else "full"
    return {"version": QUALITY_VERSION, "outcome": outcome, "overallScore": overall,
            "overallReliability": reliability, "unheardRatio": round(1 - heard, 3),
            "overallWeights": weights, "pitchMatchRate": match_rate, "issues": issues,
            "pitchCoverage": round(pitch_coverage, 3), "timingCoverage": round(timing_coverage, 3),
            # This indicates a usable timeline, never a claim of verified accuracy.
            "followReady": bool(valid_timeline and summary.get("confidence") != "low"
                                and not summary.get("syncAdvice") and not mismatch)}
