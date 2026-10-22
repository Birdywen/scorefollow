"""Voices with omitted rests (Python twin of lib/score-edit.ts voiceGaps / fillVoiceGap).

Engravers often leave out a rest in one voice (a bass struck on beats 1 and 2 with the eighth rests
unprinted). OMR then packs that voice to the start of the bar and every onset after the gap is wrong.
`short_voices` finds voices that stop early in an otherwise full bar; `place` picks onsets for their
notes (order and durations kept, beam groups never split) from the other voices, and optionally from a
performance: a pianist who plays both voices does not shift one of them inside a bar, so the take tells
where the hidden rest was. `fill` writes the gaps as invisible <forward>, so the printed score is the same.
"""
import re
from dataclasses import dataclass, field

# Placement weights; keep in step with W in lib/score-edit.ts.
W = {"onset": 2, "shared": 3, "same": 0, "other": 1, "none": 0, "offgrid": 1, "gap": 0.6, "margin": 2}

_TOK = re.compile(r"<(note|backup|forward)(?=[\s>])[\s\S]*?</\1>")
_STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_ACC = {"sharp": 1, "natural": 0, "flat": -1, "double-sharp": 2, "sharp-sharp": 2, "flat-flat": -2,
        "natural-sharp": 1, "natural-flat": -1}


def _text(block: str, tag: str):
    m = re.search(rf"<{tag}(?:\s[^>]*)?>([^<]*)</{tag}>", block)
    return m.group(1).strip() if m else None


def _num(block: str, tag: str):
    t = _text(block, tag)
    try:
        return float(t) if t not in (None, "") else None
    except ValueError:
        return None


@dataclass
class Event:
    key: tuple
    pos: int
    dur: int
    rest: bool
    midis: list
    staff: str
    insert_at: int
    tok_first: int
    tok_last: int
    beam_on: bool


@dataclass
class Voice:
    part: int
    measure: int            # 0-based ordinal of the measure in its part (parse_piano_score's measure - 1)
    number: str
    staff: str
    voice: str
    divisions: int
    length: int             # bar length, divisions
    beat: int               # one beat of the time signature, divisions
    events: list
    others: list
    toks: list = field(repr=False, default_factory=list)


def _measures(xml: str):
    for pi, pm in enumerate(re.finditer(r"<part(?=[\s>])[^>]*>[\s\S]*?</part>", xml)):
        base, body = pm.start(), pm.group(0)
        fifths, divisions, beats, beat_type = 0, 1, None, None
        for mi, mm in enumerate(re.finditer(r"<measure(?=[\s>])[^>]*>[\s\S]*?</measure>", body)):
            block = mm.group(0)
            opening = block[:block.index(">") + 1]
            for am in re.finditer(r"<attributes(?=[\s>])[\s\S]*?</attributes>", block):
                a = am.group(0)
                f = _num(a, "fifths")
                if f is not None:
                    fifths = int(f)
                d = _num(a, "divisions")
                if d and d > 0:
                    divisions = int(d)
                if re.search(r"<senza-misura", a):
                    beats = beat_type = None
                if re.search(r"<time(?=[\s>])", a):
                    beats, beat_type = _num(a, "beats"), _num(a, "beat-type")
            num = re.search(r'\snumber="([^"]*)"', opening)
            yield {"part": pi, "index": mi, "start": base + mm.start(), "block": block,
                   "number": num.group(1) if num else str(mi + 1),
                   "implicit": 'implicit="yes"' in opening, "fifths": fifths, "divisions": divisions,
                   "beats": beats, "beat_type": beat_type}


def _key_alter(fifths: int, step: str) -> int:
    if fifths > 0 and step in "FCGDAEB"[:fifths]:
        return 1
    if fifths < 0 and step in "BEADGCF"[:-fifths]:
        return -1
    return 0


def _events(m):
    toks, events = [], []
    for t in _TOK.finditer(m["block"]):
        s = m["start"] + t.start()
        toks.append({"kind": t.group(1), "start": s, "end": m["start"] + t.end(),
                     "dur": int(_num(t.group(0), "duration") or 0), "text": t.group(0)})
    pos, grace_from, memory = 0, -1, {}
    for ti, t in enumerate(toks):
        b = t["text"]
        if t["kind"] != "note":
            pos += -t["dur"] if t["kind"] == "backup" else t["dur"]
            grace_from = -1
            continue
        if re.search(r"<grace(?=[\s/>])", b):
            if grace_from < 0:
                grace_from = ti
            continue
        staff, voice = _text(b, "staff") or "1", _text(b, "voice") or "1"
        midi = None
        pb = re.search(r"<pitch>([\s\S]*?)</pitch>", b)
        if pb:
            step, octave, explicit = _text(pb.group(1), "step"), _num(pb.group(1), "octave"), _num(pb.group(1), "alter")
            if step in _STEP and octave is not None:
                k = (staff, step, int(octave))
                acc = _text(b, "accidental")
                if explicit is not None:
                    alter = memory[k] = int(round(explicit))
                elif acc in _ACC:
                    alter = memory[k] = _ACC[acc]
                else:
                    alter = memory.get(k, _key_alter(m["fifths"], step))
                midi = 12 * (int(octave) + 1) + _STEP[step] + alter
        if re.search(r"<chord\s*/>", b) and events:
            if midi is not None:
                events[-1].midis.append(midi)
            events[-1].tok_last = ti
            continue
        first = grace_from if grace_from >= 0 else ti
        events.append(Event((staff, voice), pos, t["dur"], bool(re.search(r"<rest(?=[\s/>])", b)),
                            [midi] if midi is not None else [], staff, toks[first]["start"], first, ti,
                            bool(re.search(r'<beam\s+number="1"\s*>\s*(begin|continue)\s*<', b))))
        grace_from = -1
        pos += t["dur"]
    return toks, events


def short_voices(xml: str) -> list:
    """Voices that stop before the end of an otherwise full bar and can be re-spaced safely
    (written as one unbroken run of notes)."""
    out = []
    for m in _measures(xml):
        if m["implicit"] or not m["beats"] or not m["beat_type"]:
            continue
        L = round(m["beats"] * 4 / m["beat_type"] * m["divisions"])
        beat = round(4 / m["beat_type"] * m["divisions"])
        toks, events = _events(m)
        if not events:
            continue
        pos = top = 0
        for t in toks:  # whole-bar length, as the parser sees it
            if t["kind"] == "backup":
                pos -= t["dur"]
            elif t["kind"] == "forward":
                pos += t["dur"]
            elif not re.search(r"<grace(?=[\s/>])", t["text"]) and not re.search(r"<chord\s*/>", t["text"]):
                pos += t["dur"]
            top = max(top, pos)
        if top != L:
            continue
        for key in dict.fromkeys(e.key for e in events):
            mine = [e for e in events if e.key == key]
            if mine[-1].pos + mine[-1].dur >= L or all(e.rest for e in mine):
                continue
            if not all(k == 0 or (e.tok_first == mine[k - 1].tok_last + 1 and e.pos == mine[k - 1].pos + mine[k - 1].dur)
                       for k, e in enumerate(mine)):
                continue
            out.append(Voice(m["part"], m["index"], m["number"], key[0], key[1], m["divisions"], L, beat,
                             mine, [e for e in events if e.key != key], toks))
    return out


def _gcd(a: int, b: int) -> int:
    while b:
        a, b = b, a % b
    return abs(a)


def place(v: Voice, evidence=None):
    """(onsets, cost, cost_as_recognized) in divisions. evidence(event_index, onset) -> extra cost
    (e.g. from a performance) is added to the score-only cost of each note."""
    at = {}
    for o in v.others:
        if o.rest:
            continue
        a = at.setdefault(o.pos, {"staffs": set(), "midis": {}})
        a["staffs"].add(o.staff)
        for mm in o.midis:
            a["midis"].setdefault(mm, set()).add(o.dur)

    def shared(e, a):
        if not e.midis or not all(mm in a["midis"] for mm in e.midis):
            return 0
        return W["same"] if all(e.dur in a["midis"][mm] for mm in e.midis) else W["shared"]

    def cost(i, t):
        e = v.events[i]
        c = evidence(i, t) if evidence else 0.0
        if e.rest:
            return c
        a = at.get(t)
        if a and e.staff in a["staffs"]:
            c -= W["onset"] + shared(e, a)
        elif a:
            c -= W["other"]
        else:
            c += W["none"]
        if e.dur <= v.beat and t % e.dur:
            c += W["offgrid"]
        return c

    mine, L = v.events, v.length
    step = v.beat
    for e in mine:
        step = _gcd(step, e.dur)
    cands = {t for t in at if t % step == 0} | set(range(0, L + 1, step)) | {e.pos for e in mine}
    ts = sorted(t for t in cands if 0 <= t <= L)
    back, prev = [], {}
    for i, e in enumerate(mine):
        cur = {}
        for t in ts:
            if t + e.dur > L:
                continue
            best = None
            if i == 0:
                best = (cost(i, t) + (W["gap"] if t > 0 else 0), -1)
            else:
                for pt, (pc, _p) in prev.items():
                    end = pt + mine[i - 1].dur
                    if end > t or (t > end and mine[i - 1].beam_on):
                        continue
                    c = pc + cost(i, t) + (W["gap"] if t > end else 0)
                    if best is None or c < best[0]:
                        best = (c, pt)
            if best:
                cur[t] = best
        back.append(cur)
        prev = cur
    if not prev:
        return None
    bt, (bc, _p) = min(prev.items(), key=lambda kv: kv[1][0])
    onsets = []
    for i in range(len(mine) - 1, -1, -1):
        onsets.insert(0, bt)
        bt = back[i][bt][1]
    cc = sum(cost(i, e.pos) + (W["gap"] if e.pos > (mine[i - 1].pos + mine[i - 1].dur if i else 0) else 0)
             for i, e in enumerate(mine))
    return onsets, bc, cc


def proposal(v: Voice, evidence=None, margin: float | None = None):
    """Onsets to move to, or None when nothing fits clearly better than the recognized placement."""
    r = place(v, evidence)
    if not r:
        return None
    onsets, best, current = r
    need = W["margin"] if margin is None else margin
    if current - best < need or all(t == e.pos for t, e in zip(onsets, v.events)):
        return None
    return onsets


def fill(xml: str, v: Voice, onsets: list) -> str:
    """Insert <forward> gaps so the voice's notes start at `onsets`; later voices keep their place."""
    ev, edits, total = v.events, [], 0
    for k, t in enumerate(onsets):
        shifted = t - ev[k].pos
        before = onsets[k - 1] - ev[k - 1].pos if k else 0
        if shifted > before:
            gap = shifted - before
            edits.append((ev[k].insert_at, ev[k].insert_at,
                          f"<forward><duration>{gap}</duration><voice>{v.voice}</voice><staff>{v.staff}</staff></forward>"))
            total += gap
    if not total:
        return xml
    nxt = v.toks[ev[-1].tok_last + 1] if ev[-1].tok_last + 1 < len(v.toks) else None
    if nxt and nxt["kind"] == "backup":
        edits.append((nxt["start"], nxt["end"],
                      re.sub(r"<duration>\s*\d+\s*</duration>", f"<duration>{nxt['dur'] + total}</duration>", nxt["text"], count=1)))
    elif nxt:
        edits.append((nxt["start"], nxt["start"], f"<backup><duration>{total}</duration></backup>"))
    for s, e, text in sorted(edits, key=lambda x: -x[0]):
        xml = xml[:s] + text + xml[e:]
    return xml


def fill_all(xml: str, choose) -> tuple[str, list]:
    """Apply choose(voice) -> onsets|None to every short voice, one at a time (offsets move after
    each edit). Returns the new XML and the fixes made."""
    fixes, done = [], set()
    while True:
        todo = [v for v in short_voices(xml) if (v.part, v.measure, v.staff, v.voice) not in done]
        if not todo:
            return xml, fixes
        v = todo[0]
        done.add((v.part, v.measure, v.staff, v.voice))
        onsets = choose(v)
        if onsets:
            fixes.append({"part": v.part, "measure": v.measure + 1, "number": v.number, "staff": v.staff,
                          "voice": v.voice, "from": [e.pos / v.divisions for e in v.events],
                          "to": [t / v.divisions for t in onsets]})
            xml = fill(xml, v, onsets)
