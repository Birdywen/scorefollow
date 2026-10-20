"""How far each measure of an OMR-read piano score can be trusted, from the score alone.

Every check is a symptom a correctly read measure cannot have: voices that over- or under-fill the
time signature, two staves of different lengths, a notated type that disagrees with its duration, a
beam left open, or one key written in two voices of a staff off each other's beat (a lost rest).
`check_score` returns per printed measure the symptoms found; `assess` turns them, and the agreement
of a second independent reading, into a doubt in [0, 1]. `note_doubt` then refines it per note: two
readers agreeing on the written key leave the decision to the player, a second reader siding with
the take points at the score.
"""
from collections import Counter, defaultdict
from decimal import Decimal

from .engine import STEP, musicxml_number, validate_musicxml

TYPE_QUARTERS = {"maxima": 32, "long": 16, "breve": 8, "whole": 4, "half": 2, "quarter": 1, "eighth": 0.5,
                 "16th": 0.25, "32nd": 0.125, "64th": 0.0625, "128th": 0.03125}
EPS = 1e-3


def _tag(el) -> str:
    return el.tag.rsplit("}", 1)[-1]


def _nominal(time_sig) -> float | None:
    beats, beat_type = time_sig
    try:
        return sum(float(b) for b in str(beats).split("+")) * 4 / float(beat_type)
    except (TypeError, ValueError):
        return None


def check_score(xml: str) -> dict[int, list[dict]]:
    """{printed measure ordinal: [{"kind", "detail"}]} for the first part. Measure ordinals match
    piano_score's `measure` field (1-based position in the part, not the printed number)."""
    root = validate_musicxml(xml)
    part = root.find("./{*}part")
    if part is None:
        return {}
    measures = part.findall("./{*}measure")
    found: dict[int, list[dict]] = defaultdict(list)
    divisions, time_sig = Decimal(1), (None, None)
    for mi, m in enumerate(measures):
        no = mi + 1
        d = m.find("./{*}attributes/{*}divisions")
        if d is not None:
            divisions = musicxml_number(d.text, "divisions")
        t = m.find("./{*}attributes/{*}time")
        if t is not None:
            time_sig = (t.findtext("./{*}beats"), t.findtext("./{*}beat-type"))
        nominal = _nominal(time_sig)
        pos = 0.0
        voice_len: dict[tuple, float] = defaultdict(float)       # (staff, voice) -> summed durations
        voice_end: dict[tuple, float] = defaultdict(float)       # (staff, voice) -> last end position
        staff_end: dict[str, float] = defaultdict(float)
        strikes: dict[tuple, list] = defaultdict(list)           # (staff, midi) -> [(onset, voice)]
        open_beams: dict[tuple, int] = defaultdict(int)
        last_onset = 0.0
        for item in m:
            tag = _tag(item)
            if tag in ("backup", "forward"):
                q = float(musicxml_number(item.findtext("./{*}duration"), "duration") / divisions)
                if tag == "forward":
                    key = (item.findtext("./{*}staff") or "1", item.findtext("./{*}voice") or "1")
                    voice_len[key] += q
                    voice_end[key] = max(voice_end[key], pos + q)
                pos = max(0.0, pos - q if tag == "backup" else pos + q)
                continue
            if tag != "note" or item.find("./{*}grace") is not None or item.find("./{*}cue") is not None:
                continue
            dur_txt = item.findtext("./{*}duration")
            length = float(musicxml_number(dur_txt, "duration") / divisions) if dur_txt else 0.0
            chord = item.find("./{*}chord") is not None
            staff = item.findtext("./{*}staff") or "1"
            voice = item.findtext("./{*}voice") or "1"
            onset = last_onset if chord else pos
            if not chord:
                last_onset = pos
                pos += length
                voice_len[(staff, voice)] += length
            voice_end[(staff, voice)] = max(voice_end[(staff, voice)], onset + length)
            staff_end[staff] = max(staff_end[staff], onset + length)
            # The notated type (with dots and tuplet ratio) must give the encoded duration.
            typ = item.findtext("./{*}type")
            if typ in TYPE_QUARTERS and length > 0:
                q = TYPE_QUARTERS[typ]
                dots = len(item.findall("./{*}dot"))
                q *= 2 - 0.5 ** dots
                tm = item.find("./{*}time-modification")
                if tm is not None:
                    try:
                        q *= float(tm.findtext("./{*}normal-notes")) / float(tm.findtext("./{*}actual-notes"))
                    except (TypeError, ValueError, ZeroDivisionError):
                        pass
                if abs(q - length) > EPS and item.find("./{*}rest") is None:
                    found[no].append({"kind": "type_duration", "detail": f"{typ} encoded as {length:g} beats"})
            for b in item.findall("./{*}beam"):
                key = (staff, voice, b.get("number") or "1")
                if b.text == "begin":
                    open_beams[key] += 1
                elif b.text == "end":
                    open_beams[key] -= 1
            pitch = item.find("./{*}pitch")
            if pitch is not None:
                step = pitch.findtext("./{*}step")
                octave = pitch.findtext("./{*}octave")
                if step in STEP and octave is not None:
                    alter = pitch.findtext("./{*}alter")
                    midi = 12 * (int(octave) + 1) + STEP[step] + (int(round(float(alter))) if alter else 0)
                    strikes[(staff, midi)].append((onset, voice))
        last = mi == len(measures) - 1
        edge = mi == 0 or last or m.get("implicit") == "yes"
        if nominal:
            for (staff, voice), total in voice_len.items():
                if total > nominal + EPS:
                    found[no].append({"kind": "voice_overfull", "detail": f"staff {staff} voice {voice}: {total:g}/{nominal:g}"})
                elif total < nominal - EPS and not edge and voice_end[(staff, voice)] > 0:
                    # A voice that stops early. Secondary voices may legally drop out mid-bar, but one
                    # that is the only voice of its staff is missing a note or rest.
                    alone = sum(1 for (s, _v) in voice_len if s == staff) == 1
                    found[no].append({"kind": "voice_short" if alone else "voice_short_secondary",
                                      "detail": f"staff {staff} voice {voice}: {total:g}/{nominal:g}"})
            ends = {s: e for s, e in staff_end.items() if e > 0}
            if len(ends) >= 2 and max(ends.values()) - min(ends.values()) > EPS and not edge:
                found[no].append({"kind": "staff_mismatch",
                                  "detail": ", ".join(f"staff {s}: {e:g}" for s, e in sorted(ends.items()))})
        if any(v != 0 for v in open_beams.values()):
            found[no].append({"kind": "beam_open", "detail": ""})
        for (staff, midi), hits in strikes.items():
            if any(v1 != v2 and EPS < abs(o1 - o2) <= 1.0 for i, (o1, v1) in enumerate(hits) for o2, v2 in hits[i + 1:]):
                found[no].append({"kind": "voice_echo", "detail": f"staff {staff} key {midi}"})
                break
    return dict(found)


def _bag_f1(a: Counter, b: Counter) -> float:
    if not a and not b:
        return 1.0
    common = sum((a & b).values())
    return 2 * common / max(1, sum(a.values()) + sum(b.values()))


def read_as_printed(xml: str, parse=None):
    """Notes of a score read without unfolding repeats, with their beat inside the measure."""
    if parse is None:
        from .piano_score import parse_piano_score as parse
    spans: list = []
    notes = parse(xml, unfold=False, spans=spans)
    starts = {m: b for m, b, _e in spans}
    return [{**n, "inMeasure": n["onsetBeat"] - starts.get(n["measure"], 0.0)} for n in notes]


def compare_readings(primary: list[dict], other: list[dict]) -> dict[int, dict]:
    """Agreement of a second, independent OMR reading with the primary one, per primary measure.

    Both inputs come from read_as_printed. Measures are paired by dynamic
    time warping on their pitch content (the readers may split or merge measures differently); each
    primary measure is then compared with the union of the other reading's measures paired with it.
    Returns {measure: {"pitch": F1 of the key multisets, "onset": F1 of (key, onset in measure)}}."""
    pa, pb, pairs = _paired(primary, other)
    if not pa or not pb:
        return {}
    bags_a = [Counter(n["pitchMidi"] for n in ns) for _m, ns in pa]
    out = {}
    for ia, (m, notes_a) in enumerate(pa):
        notes_b = [n for jb in sorted(set(pairs.get(ia, []))) for n in pb[jb][1]]
        on_a = Counter((n["pitchMidi"], round(n["inMeasure"] * 12)) for n in notes_a)
        on_b = Counter((n["pitchMidi"], round(n["inMeasure"] * 12)) for n in notes_b)
        out[m] = {"pitch": round(_bag_f1(bags_a[ia], Counter(n["pitchMidi"] for n in notes_b)), 3),
                  "onset": round(_bag_f1(on_a, on_b), 3)}
    return out


def witness(primary: list[dict], other: list[dict]) -> dict[int, tuple[Counter, Counter]]:
    """{primary measure: (primary keys, second reading's keys)} as multisets, for note-level checks:
    two independent readers rarely make the same mistake on the same note."""
    pa, pb, pairs = _paired(primary, other)
    out = {}
    for ia, (m, notes_a) in enumerate(pa):
        notes_b = [n for jb in sorted(set(pairs.get(ia, []))) for n in pb[jb][1]]
        if notes_b:
            out[m] = (Counter(n["pitchMidi"] for n in notes_a), Counter(n["pitchMidi"] for n in notes_b))
    return out


def _paired(primary: list[dict], other: list[dict]):
    """Measures of both readings ([(measure, notes)]) and {primary index: [other indices]} paired by
    dynamic time warping on pitch content."""
    def by_measure(notes):
        out: dict[int, list] = defaultdict(list)
        for n in notes:
            out[n["measure"]].append(n)
        return [(m, out[m]) for m in sorted(out)]

    pa, pb = by_measure(primary), by_measure(other)
    if not pa or not pb:
        return pa, pb, {}
    bags_a = [Counter(n["pitchMidi"] for n in ns) for _m, ns in pa]
    bags_b = [Counter(n["pitchMidi"] for n in ns) for _m, ns in pb]
    na, nb = len(pa), len(pb)
    inf = float("inf")
    cost = [[inf] * (nb + 1) for _ in range(na + 1)]
    back = [[None] * (nb + 1) for _ in range(na + 1)]
    for j in range(nb + 1):
        cost[0][j] = 0.0   # leading measures of the other reading (title residue, an extra page) are free
    for i in range(1, na + 1):
        for j in range(1, nb + 1):
            c = 1 - _bag_f1(bags_a[i - 1], bags_b[j - 1])
            best = min((cost[i - 1][j - 1], (i - 1, j - 1)), (cost[i - 1][j] + 0.3, (i - 1, j)),
                       (cost[i][j - 1] + 0.3, (i, j - 1)))
            cost[i][j], back[i][j] = best[0] + c, best[1]
    # Free start and end in the other reading (it may hold an extra page or title residue).
    j_end = min(range(1, nb + 1), key=lambda j: cost[na][j])
    pairs: dict[int, list[int]] = defaultdict(list)
    i, j = na, j_end
    while i > 0 and j > 0:
        pairs[i - 1].append(j - 1)
        i, j = back[i][j]
    return pa, pb, pairs


# Doubt = share of a measure's score/take disagreements that the score itself causes, measured on
# professional takes of Heller Op.47 (benchmarks/piano_trust.py): the excess over the disagreement
# rate of clean measures, divided by the rate in measures with the symptom. Unlisted kinds: no weight.
# Fitted 2026-10-20 (all 24 etudes, 1266 measures; odd/even halves agree within 0.1 except where noted),
# rounded down.
SYMPTOM_DOUBT: dict[str, float] = {
    "staff_mismatch": 0.85,          # 45 measures
    "voice_overfull": 0.80,          # 33
    "voice_short": 0.75,             # 15
    "voice_short_secondary": 0.75,   # 178 (halves 0.62 / 0.82)
    "voice_echo": 0.70,              # 146
    "beam_open": 0.40,               # 9: too few to trust the fitted 0.57
}
# Same, by agreement of a second reader on the measure's keys, high to low: [(minimum agreement, doubt)].
# Measured on structurally clean measures: below 0.95 every bin gives 0.43-0.48.
AGREEMENT_DOUBT: list[tuple[float, float]] = [(0.95, 0.0), (0.0, 0.45)]

SYMPTOM_TEXT = {
    "voice_overfull": ("某声部时值超过拍号", "a voice overfills the time signature"),
    "voice_short": ("某谱表时值不满一小节", "a staff does not fill the measure"),
    "voice_short_secondary": ("某声部中途缺音或缺休止", "a voice stops short (lost note or rest)"),
    "staff_mismatch": ("上下两行谱长度不同", "the two staves differ in length"),
    "voice_echo": ("同一音在两个声部错开出现", "one key written in two voices off each other's beat"),
    "beam_open": ("符杠没有闭合", "a beam is left open"),
    "type_duration": ("音符类型与时值不符", "a note's type disagrees with its duration"),
    "reading_disagrees": ("两次独立识别结果不一致", "a second, independent reading disagrees"),
    "reading_sides_with_take": ("第二次独立识别在这里与演奏一致、与本谱不同",
                                "a second, independent reading agrees with the take, not with this score"),
}
CONFIRM_KEEP = 0.2       # share of a measure's doubt left when the second reader has the written key too
CONTRADICT_DOUBT = 0.7   # doubt when the second reader sides with the take (Audiveris loses ~10% of notes)


def second_witness(xml: str, second_xml: str | None, parse=None) -> dict:
    """witness() of the primary score against a second reading; {} without one."""
    if not second_xml:
        return {}
    try:
        return witness(read_as_printed(xml, parse), read_as_printed(second_xml))
    except ValueError:
        return {}


def note_doubt(measure_doubt: float, wit, kind: str, written: int | None = None,
               played: int | None = None) -> tuple[float, str | None]:
    """Doubt about the score for one disagreement and why: kind 'missed' (written key not played),
    'wrong' (written key, another played) or 'extra' (played key not written). wit: the measure's
    (primary keys, second reading's keys) or None. Reason: 'confirmed', 'contradicted' or None."""
    if wit is None:
        return measure_doubt, None
    prim, sec = wit
    # Copies count: a key the score writes twice (a lost rest, a duplicated notehead) is confirmed only
    # if the second reader also has it twice.
    if kind in ("missed", "wrong") and sec[written] >= prim[written]:
        return measure_doubt * CONFIRM_KEEP, "confirmed"
    if kind == "missed" or (kind == "wrong" and sec[played] > prim[played]):
        return max(measure_doubt, CONTRADICT_DOUBT), "contradicted"
    if kind == "extra":
        if sec[played] > prim[played]:
            return max(measure_doubt, CONTRADICT_DOUBT), "contradicted"
        return measure_doubt * CONFIRM_KEEP, "confirmed"
    return measure_doubt, None


def assess(xml: str, second_xml: str | None = None, parse=None) -> dict[int, dict]:
    """{measure: {"doubt": 0..1, "reasons": [kinds], "agreement": F1 or None}} for measures with
    any doubt. `parse` reads the primary score (the engine's parser, so tests can alter it)."""
    found = check_score(xml)
    agree = {}
    if second_xml:
        try:
            agree = compare_readings(read_as_printed(xml, parse), read_as_printed(second_xml))
        except ValueError:
            agree = {}
    out = {}
    for m in set(found) | set(agree):
        kinds = sorted({i["kind"] for i in found.get(m, []) if SYMPTOM_DOUBT.get(i["kind"], 0) > 0})
        # Symptoms of one cause (a lost rest shows as a short voice and an echo) are not independent:
        # the strongest one stands for the structure.
        d_struct = max((SYMPTOM_DOUBT[k] for k in kinds), default=0.0)
        a = agree.get(m, {}).get("pitch")
        d_read = next((d for lo, d in AGREEMENT_DOUBT if a is not None and a >= lo), 0.0) if a is not None else 0.0
        if d_read > 0:
            kinds.append("reading_disagrees")
        doubt = 1 - (1 - d_struct) * (1 - d_read)
        if doubt > 0:
            out[m] = {"doubt": round(doubt, 3), "reasons": kinds, "agreement": a}
    return out
