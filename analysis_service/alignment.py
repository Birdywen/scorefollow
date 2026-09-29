"""Conservative subsequence alignment for locating an audio excerpt in a score.

Only the *starting score note* is inferred here. Warped DTW times must never be
used as ground truth for rhythm scoring; the engine uses its independent beat
tracker after localization.
"""

import math

import numpy as np


def usable_events(pitch_notes: list) -> list[tuple[float, float, float]]:
    """Validate sensor output before using its order or timestamps as anchors."""
    events = []
    previous_end = 0.0
    for segment in pitch_notes:
        try:
            start, end, midi = map(float, segment)
        except (TypeError, ValueError) as exc:
            raise ValueError("音高事件格式无效") from exc
        if not all(math.isfinite(v) for v in (start, end, midi)) or start < 0 or end <= start:
            raise ValueError("音高事件时间或数值无效")
        if start < previous_end - .001:
            raise ValueError("音高事件重叠或未按时间排序")
        previous_end = end
        if end - start >= .09 and 36 <= midi <= 96:
            events.append((start, end, midi))
    return events


def locate_excerpt(score_notes: list[dict], pitch_notes: list, *, max_events: int = 64,
                   beat_map: list | None = None) -> tuple[int, float]:
    """Return (score-note index, mean alignment cost); fail closed if ambiguous.

    Short, unreliable pYIN segments are skipped. Bounded edit-distance DTW
    tolerates missing/extra onsets and local tempo changes without choosing a
    pitch merely because it matches the score. Scoring uses continuous cents.
    """
    segments = usable_events(pitch_notes)[:max_events]
    events = [midi for _, _, midi in segments]
    if len(events) < 8 or len(score_notes) < 8:
        raise ValueError("片段定位需要至少 8 个可靠的音高事件；请指定起始小节")
    n = len(events)
    positions = None
    if beat_map is not None:
        beats = sorted(set(float(b) for b in beat_map if math.isfinite(float(b)) and float(b) >= 0))
        if len(beats) >= 4:
            intervals = np.diff(beats)
            med = float(np.median(intervals))
            if med > 0 and float(np.max(intervals)) <= med * 2.5:
                def position(t):
                    if t < beats[0]:
                        return (t - beats[0]) / med
                    if t > beats[-1]:
                        return len(beats) - 1 + (t - beats[-1]) / med
                    return float(np.interp(t, beats, np.arange(len(beats))))
                origin = position(segments[0][0])
                positions = [position(segment[0]) - origin for segment in segments]
    candidates = []
    for start in range(len(score_notes)):
        written = [float(note["pitchMidi"]) for note in score_notes[start:start + 2 * n + 4]]
        anchor_cents = abs(events[0] - written[0]) * 100
        # A low average cost cannot justify an unrelated opening note: it
        # shifts every later scoring window even if the passage was located.
        if min(anchor_cents, abs(anchor_cents - 1200)) > 150:
            continue
        if len(written) < max(6, int(n * .65)):
            continue
        # Force the first audio event to match the proposed first score note.
        # Otherwise leading deletions make the returned time anchor fictitious.
        prev = [0.0] + [float("inf")] * len(written)
        for i, midi in enumerate(events, 1):
            row = [float("inf")] * (len(written) + 1)
            for j, target in enumerate(written, 1):
                if abs(i - j) > max(4, n // 3):
                    continue
                cents = abs(midi - target) * 100
                # A 1200-cent discrepancy may be a pitch-tracker octave error,
                # but is never as cheap as an exact match.
                octave = abs(cents - 1200) / 100 + .75
                difference = min(2.5, cents / 100, octave)
                if positions is not None:
                    # Retain elapsed time across missing pYIN events. The grid
                    # is audio-only; DTW does not manufacture rhythm evidence.
                    score_offset = score_notes[start + j - 1]["onsetBeat"] - score_notes[start]["onsetBeat"]
                    difference += min(3.0, abs(positions[i - 1] - score_offset) * 2)
                row[j] = (prev[j - 1] + difference if i == 1 or j == 1 else
                          min(prev[j - 1] + difference,
                              prev[j] + 1.25, row[j - 1] + .85))
            prev = row
        minimum = min(prev[max(6, int(n * .65)):]) / n
        candidates.append((minimum, start))
    if not candidates:
        raise ValueError("录音与乐谱不足以定位片段；请指定起始小节")
    candidates.sort()
    best, index = candidates[0]
    # Adjacent start indices can describe the same excerpt via a single skipped
    # event; compare distinct passages instead of treating them as repeats.
    alternative = next((cost for cost, i in candidates
                        if abs(i - index) > max(3, n // 3)), float("inf"))
    # Even nearby starts are ambiguous when they fit equally well. Excluding
    # them wholesale hides short repeated motifs and picks the earliest copy.
    tied_start = any(i != index and abs(cost - best) <= 1e-8 for cost, i in candidates)
    if best > .70 or alternative - best < .16 or tied_start:
        raise ValueError("录音片段与乐谱不吻合或重复乐句无法区分；请指定起始小节")
    if n > 24:
        try:
            short_index, _ = locate_excerpt(score_notes, pitch_notes, max_events=24, beat_map=beat_map)
        except ValueError:
            pass  # More context may legitimately resolve an ambiguous prefix.
        else:
            if short_index != index:
                raise ValueError("长短片段定位起点不一致，无法可靠评分；请指定起始小节")
    return index, round(best, 3)
