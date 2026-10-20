"""Polyphonic piano MusicXML parser: chords, grand staff, multiple voices, ties, repeats.

Output notes use the same fields as engine.parse_score (id, measure, onsetBeat, durationBeat,
pitchMidi; beats are quarter notes) plus staff/voice. `measure` is the printed measure ordinal,
so after repeat unfolding the same measure appears at two onsetBeats.
"""
from decimal import Decimal

from .engine import ACCIDENTAL_ALTER, STEP, musicxml_number, validate_musicxml

MAX_NOTES = 8000


def _tag(el) -> str:
    return el.tag.rsplit("}", 1)[-1]


def _repeat_info(measure):
    fwd = bwd = False
    times = 2
    endings, ending_stop = set(), False
    for bl in measure.findall("./{*}barline"):
        rep = bl.find("./{*}repeat")
        if rep is not None:
            if rep.get("direction") == "forward":
                fwd = True
            elif rep.get("direction") == "backward":
                bwd = True
                times = int(rep.get("times") or 2)
        end = bl.find("./{*}ending")
        if end is not None:
            if end.get("type") == "start":
                endings |= {int(x) for x in (end.get("number") or "1").replace(" ", "").split(",") if x.isdigit()}
            if end.get("type") in ("stop", "discontinue"):
                ending_stop = True
    return fwd, bwd, times, endings, ending_stop


def play_order(measures) -> list[int]:
    """Indices of measures in performance order, with simple repeats and volta endings unfolded."""
    info = [_repeat_info(m) for m in measures]
    order, i, start, taken, cur_pass, jumped = [], 0, 0, {}, 1, False
    while i < len(measures) and len(order) < 20 * len(measures):
        fwd, bwd, times, endings, _ = info[i]
        if endings and cur_pass not in endings:
            j = i  # skip this volta: through the measure that closes it
            while j < len(measures) and not info[j][4]:
                j += 1
            i, jumped = j + 1, False
            continue
        if fwd and not jumped:
            start, cur_pass = i, 1
        jumped = False
        order.append(i)
        if bwd:
            if taken.get(i, 0) < times - 1:
                taken[i] = taken.get(i, 0) + 1
                cur_pass += 1
                i, jumped = start, True
                continue
            start, cur_pass = i + 1, 1
        i += 1
    return order


def has_repeats(xml: str) -> bool:
    root = validate_musicxml(xml)
    return root.find(".//{*}repeat") is not None or root.find(".//{*}ending") is not None


def parse_piano_score(xml: str, unfold: bool = True, spans: list | None = None,
                      issues: list | None = None) -> list[dict]:
    """spans, if given, receives [(measure, startBeat, endBeat)] in performance order (first part).
    issues, if given, receives {"measure", "beats", "expected"} for printed measures whose content
    does not fill the time signature (OMR rhythm errors); pickup and final measures may be short."""
    root = validate_musicxml(xml)
    if _tag(root) != "score-partwise":
        raise ValueError("仅支持 score-partwise MusicXML")
    parts = root.findall("./{*}part")
    if not parts:
        raise ValueError("MusicXML 没有声部")
    notes: list[dict] = []
    for p_index, part in enumerate(parts):
        if part.find(".//{*}transpose") is not None:
            raise ValueError("移调记谱暂不支持，请使用实音 MusicXML")
        measures = part.findall("./{*}measure")
        order = play_order(measures) if unfold else list(range(len(measures)))
        # Attributes in force at each measure (divisions/key), carried in printed order.
        divs, keys = [], []
        divisions, key_alter = Decimal(1), {}
        for m in measures:
            d = m.find("./{*}attributes/{*}divisions")
            if d is not None:
                divisions = musicxml_number(d.text, "divisions")
                if divisions <= 0:
                    raise ValueError("MusicXML divisions 无效")
            for f in m.findall("./{*}attributes/{*}key/{*}fifths"):
                fifths = int(musicxml_number(f.text, "fifths"))
                if not -7 <= fifths <= 7:
                    raise ValueError("MusicXML 调号无效")
                key_alter = ({s: 1 for s in "FCGDAEB"[:fifths]} if fifths > 0 else
                             {s: -1 for s in "BEADGCF"[:-fifths]} if fifths < 0 else {})
            divs.append(divisions)
            keys.append(dict(key_alter))
        beat = 0.0
        open_ties: dict[tuple, dict] = {}  # (staff, midi) -> note awaiting a tie stop
        checked: set[int] = set()
        last_in_voice: dict[tuple, dict] = {}   # (staff, voice) -> previous struck note
        slur_from: dict[tuple, dict] = {}       # (staff, voice, number) -> note where a slur starts
        for mi in order:
            m = measures[mi]
            divisions, key_alter = divs[mi], keys[mi]
            accidentals: dict[tuple, int] = {}
            pos = 0.0  # quarter beats from measure start
            last_onset = 0.0
            measure_len = 0.0
            for item in m:
                tag = _tag(item)
                if tag in ("backup", "forward"):
                    q = float(musicxml_number(item.findtext("./{*}duration"), "duration") / divisions)
                    pos += -q if tag == "backup" else q
                    pos = max(pos, 0.0)
                    continue
                if tag != "note" or item.find("./{*}grace") is not None or item.find("./{*}cue") is not None:
                    continue
                dur_txt = item.findtext("./{*}duration")
                length = float(musicxml_number(dur_txt, "duration") / divisions) if dur_txt else 0.0
                chord = item.find("./{*}chord") is not None
                onset = last_onset if chord else pos
                if not chord:
                    last_onset = pos
                    pos += length
                measure_len = max(measure_len, pos)
                pitch = item.find("./{*}pitch")
                if pitch is None:
                    continue
                staff = item.findtext("./{*}staff") or "1"
                voice = item.findtext("./{*}voice") or "1"
                name = pitch.findtext("./{*}step")
                if name not in STEP:
                    raise ValueError("MusicXML 音名无效")
                octave = int(musicxml_number(pitch.findtext("./{*}octave"), "octave"))
                alter_el = pitch.find("./{*}alter")
                acc_key = (staff, name, octave)
                if alter_el is not None:
                    alter = int(round(float(musicxml_number(alter_el.text, "alter"))))
                    accidentals[acc_key] = alter
                else:
                    acc = (item.findtext("./{*}accidental") or "").strip()
                    if acc in ACCIDENTAL_ALTER:
                        alter = ACCIDENTAL_ALTER[acc]
                        accidentals[acc_key] = alter
                    else:
                        alter = accidentals.get(acc_key, key_alter.get(name, 0))
                midi = 12 * (octave + 1) + STEP[name] + alter
                if not 21 <= midi <= 108:
                    raise ValueError("钢琴音域为 MIDI 21–108")
                ties = {t.get("type") for t in item.findall("./{*}tie")}
                key = (p_index, staff, midi)
                start_beat = beat + onset
                held = open_ties.get(key)
                slurs = [(sl.get("type"), sl.get("number") or "1") for sl in item.findall("./{*}notations/{*}slur")]
                prev = last_in_voice.get((staff, voice))
                # A slur joining two adjacent notes of the same pitch is a tie (OMR often reads ties as slurs).
                slur_tie = not chord and prev is not None and prev["pitchMidi"] == midi and any(
                    t == "stop" and slur_from.get((staff, voice, num)) is prev for t, num in slurs)
                if slur_tie and abs(prev["onsetBeat"] + prev["durationBeat"] - start_beat) < 1e-3:
                    held = prev
                    ties = ties | {"stop"}
                if "stop" in ties and held is not None and abs(held["onsetBeat"] + held["durationBeat"] - start_beat) < 1e-3:
                    held["durationBeat"] += length  # continuation, not a new strike
                    if "start" not in ties:
                        open_ties.pop(key, None)
                    for t, num in slurs:
                        if t == "start":
                            slur_from[(staff, voice, num)] = held
                    continue
                note = {"measure": mi + 1, "onsetBeat": round(start_beat, 6), "durationBeat": length,
                        "pitchMidi": midi, "staff": int(staff) if staff.isdigit() else 1, "voice": voice}
                if item.find("./{*}notations/{*}arpeggiate") is not None:
                    note["arpeggiate"] = True  # written rolled chord: spread is intended
                notes.append(note)
                if not chord:
                    last_in_voice[(staff, voice)] = note
                for t, num in slurs:
                    if t == "start":
                        slur_from[(staff, voice, num)] = note
                if "start" in ties:
                    open_ties[key] = note
            # A measure lasts as long as its time signature says; fall back to its content.
            length_q = _measure_quarters(measures, mi, measure_len)
            if issues is not None and p_index == 0 and mi not in checked:
                checked.add(mi)
                nominal = _measure_quarters(measures, mi, 0.0)
                edge = mi in (0, len(measures) - 1) and measure_len < nominal
                if nominal and measure_len and abs(measure_len - nominal) > 1e-3 and not edge \
                        and m.get("implicit") != "yes":
                    issues.append({"measure": mi + 1, "beats": round(measure_len, 3), "expected": round(nominal, 3)})
            if spans is not None and p_index == 0:
                spans.append((mi + 1, round(beat, 6), round(beat + length_q, 6)))
            beat += length_q
    if not notes:
        raise ValueError("MusicXML 没有可演奏音符")
    if len(notes) > MAX_NOTES:
        raise ValueError(f"MusicXML 音符超过 {MAX_NOTES} 个")
    notes.sort(key=lambda n: (n["onsetBeat"], n["pitchMidi"]))
    # Two voices sharing one notehead (or OMR writing it twice) is one strike on the piano.
    merged: list[dict] = []
    for n in notes:
        prev = merged[-1] if merged else None
        if prev and prev["pitchMidi"] == n["pitchMidi"] and abs(prev["onsetBeat"] - n["onsetBeat"]) < 1e-6:
            prev["durationBeat"] = max(prev["durationBeat"], n["durationBeat"])
            continue
        merged.append(n)
    notes = merged
    for i, n in enumerate(notes, 1):
        n["id"] = f"n{i}"
    return notes


def _measure_quarters(measures, mi: int, content: float) -> float:
    beats = beat_type = None
    for m in measures[mi::-1]:  # time signature in force at measure mi
        t = m.find("./{*}attributes/{*}time")
        if t is not None:
            beats, beat_type = t.findtext("./{*}beats"), t.findtext("./{*}beat-type")
            break
    if measures[mi].get("implicit") == "yes" or not beats or not beat_type:
        return content
    try:
        nominal = float(beats) * 4 / float(beat_type)
    except ValueError:
        return content
    # OMR sometimes over/under-fills a measure; trust the signature unless content is clearly longer.
    return content if content > nominal + 1e-6 else nominal
