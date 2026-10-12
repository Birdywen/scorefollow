"""Evidence quality is independent of the player's score; zero is a valid score."""


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
    if summary.get("degraded"):
        issues.append("builtin_detectors")
    if summary.get("clipped"):
        issues.append("clipped_audio")
    if summary.get("confidence") == "low" or pitch_coverage < .6:
        issues.append("low_coverage")
    if summary.get("tempoMismatch"):
        issues.append("tempo_mismatch")
    if summary.get("takeBeyondScoreAfterSec") is not None:
        issues.append("take_beyond_score")
    if not scores:
        outcome = "insufficient_evidence"
    elif scores < 2 or "alignment_unverified" in issues or "low_coverage" in issues or \
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
    return {"version": "evidence-1", "outcome": outcome, "issues": issues,
            "pitchCoverage": round(pitch_coverage, 3), "timingCoverage": round(timing_coverage, 3),
            # This indicates a usable timeline, never a claim of verified accuracy.
            "followReady": bool(valid_timeline and summary.get("confidence") != "low"
                                and not summary.get("syncAdvice"))}
