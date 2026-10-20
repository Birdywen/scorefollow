"""piano-align-0.6: per-measure score trust from the score's structure and a second OMR reading."""
import unittest
from unittest.mock import patch

from . import piano_engine, score_trust
from .piano_score import parse_piano_score
from .score_trust import assess, check_score, compare_readings, read_as_printed
from .test_piano_align import grand_xml, melody_measures, notes_xml
from .test_piano_audio import piano_audio, take

HEAD = ('<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name>'
        '</score-part></part-list><part id="P1">')
ATTRS = ("<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats>"
         "<beat-type>4</beat-type></time><staves>2</staves></attributes>")


def raw_xml(measures):
    """measures: [xml body of each measure]; the first gets the attributes."""
    body = "".join(f'<measure number="{i + 1}">{ATTRS if i == 0 else ""}{m}</measure>' for i, m in enumerate(measures))
    return HEAD + body + "</part></score-partwise>"


def plain(rh, lh=(((48,), 4),)):
    return notes_xml(rh, 1, 1) + f"<backup><duration>{sum(e[1] for e in rh)}</duration></backup>" + notes_xml(lh, 2, 5)


class StructureTests(unittest.TestCase):
    def test_symptoms_a_correct_measure_cannot_have(self):
        four = [((60,), 1), ((62,), 1), ((64,), 1), ((65,), 1)]
        echo = (notes_xml([((64,), 4)], 1, 1) + "<backup><duration>4</duration></backup>"
                + notes_xml([((), 1), ((64,), 1), ((), 2)], 1, 2) + "<backup><duration>4</duration></backup>"
                + notes_xml([((48,), 4)], 2, 5))
        xml = raw_xml([plain(four),
                       plain(four + [((67,), 1)]),                # 5 beats in 4/4
                       plain(four[:3]),                           # right hand 3 beats, left hand 4
                       echo,                                      # E4 in voices 1 and 2, a beat apart
                       plain(four),
                       plain(four[:2])])                          # a short last measure is allowed
        found = {m: {i["kind"] for i in items} for m, items in check_score(xml).items()}
        self.assertEqual(found, {2: {"voice_overfull", "staff_mismatch"}, 3: {"voice_short", "staff_mismatch"},
                                 4: {"voice_echo"}})

    def test_second_reading_is_paired_by_content_and_disagreement_located(self):
        primary = grand_xml(melody_measures(10))
        changed = melody_measures(10)
        changed[6] = ([((p[0][0] + 2,), 1) for p in changed[6][0]], changed[6][1])      # m7 read differently
        second = grand_xml([([((90,), 4)], [((30,), 4)])] + changed)                      # plus a junk measure first
        agree = compare_readings(read_as_printed(primary), read_as_printed(second))
        low = {m for m, v in agree.items() if v["pitch"] < 0.9}
        self.assertEqual(low, {7})
        self.assertEqual(agree[3], {"pitch": 1.0, "onset": 1.0})

    def test_assess_combines_symptoms_and_reading(self):
        xml = grand_xml(melody_measures(6))
        changed = melody_measures(6)
        changed[2] = ([((p[0][0] + 1,), 1) for p in changed[2][0]], changed[2][1])
        with patch.object(score_trust, "AGREEMENT_DOUBT", [(0.95, 0.0), (0.0, 0.6)]):
            out = assess(xml, grand_xml(changed))
        self.assertEqual(set(out), {3})
        self.assertEqual((out[3]["doubt"], out[3]["reasons"]), (0.6, ["reading_disagrees"]))


class SecondReadingCacheTests(unittest.TestCase):
    def test_reading_is_stored_under_the_primary_score_and_only_found_for_it(self):
        import tempfile
        from . import second_reading
        with tempfile.TemporaryDirectory() as tmp, patch.object(second_reading, "CACHE", tmp), \
                patch.object(second_reading, "available", lambda: True), \
                patch.object(second_reading, "read_pdf", lambda pdf: "<second/>"):
            second_reading.start(b"%PDF-1.4", "<primary/>").join(5)
            self.assertEqual(second_reading.lookup("<primary/>"), "<second/>")
            self.assertIsNone(second_reading.lookup("<primary edited/>"))
        with patch.object(second_reading, "available", lambda: False):
            self.assertIsNone(second_reading.start(b"%PDF-1.4", "<primary/>"))


class EngineTrustTests(unittest.TestCase):
    def setUp(self):
        self.measures = melody_measures(14)

    def test_phantom_note_in_overfull_measure_is_not_blamed(self):
        # The OMR invented a fifth quarter note in m3 (the measure now overfills 4/4); the player is right.
        ms = list(self.measures)
        ms[2] = (ms[2][0] + [((79,), 1)], ms[2][1])
        xml = grand_xml(ms)
        notes = parse_piano_score(xml)
        phantom = next(i for i, n in enumerate(notes) if n["pitchMidi"] == 79)
        events = [e for i, e in enumerate(take(notes)) if i != phantom]
        wav, _sig = piano_audio(events, events[-1][0] + 2)
        perf = [(on, on + 0.4, float(m), 80.0) for on, m in events]
        with patch.dict(score_trust.SYMPTOM_DOUBT, {"voice_overfull": 0.8}):
            on = piano_engine.analyze_piano(wav, xml, 120, 1, perf=perf)
            off = piano_engine.analyze_piano(wav, xml, 120, 1, perf=perf, trust=False)
        self.assertEqual(off["notes"][phantom]["status"], "missed")
        x = on["notes"][phantom]
        self.assertEqual((x["status"], x["excludedReason"]), ("excluded", "score_doubtful"))
        ev = [e for e in on["summary"]["scoreCheck"]["evidence"] if e["kind"] == "score_doubtful"]
        self.assertEqual(ev[0]["measures"], [3])
        self.assertIn("时值超过拍号", ev[0]["zh"])
        self.assertEqual(on["summary"]["scoreCheck"]["doubtfulMeasures"], [3])
        self.assertGreater(on["summary"]["pitchScore"], off["summary"]["pitchScore"])

    def test_second_reading_decides_each_disagreement(self):
        # m4: the primary OMR misread one note (the player and the second reading have the real key);
        # m9: the player really played a wrong key, though m9 is structurally doubtful.
        ms = list(self.measures)
        real4 = ms[3][0][1][0][0]
        primary = list(ms)
        primary[3] = (ms[3][0][:1] + [((real4 + 2,), 1)] + ms[3][0][2:], ms[3][1])
        xml = grand_xml(primary)
        second = grand_xml(ms)
        notes = parse_piano_score(xml)
        misread = next(i for i, n in enumerate(notes) if n["measure"] == 4 and n["pitchMidi"] == real4 + 2)
        slip = next(i for i, n in enumerate(notes) if n["measure"] == 9 and n["staff"] == 1)
        events = take(notes)
        events[misread] = (events[misread][0], real4)
        events[slip] = (events[slip][0], notes[slip]["pitchMidi"] + 1)
        wav, _sig = piano_audio(events, events[-1][0] + 2)
        perf = [(on, on + 0.4, float(m), 80.0) for on, m in events]
        doubtful9 = lambda xml_: {9: [{"kind": "voice_overfull", "detail": ""}]}
        with patch.dict(score_trust.SYMPTOM_DOUBT, {"voice_overfull": 0.8}), \
                patch.object(score_trust, "check_score", doubtful9):
            r = piano_engine.analyze_piano(wav, xml, 120, 1, perf=perf, second_xml=second)
        x = r["notes"][misread]
        self.assertEqual((x["status"], x["excludedReason"]), ("excluded", "score_doubtful"))
        self.assertEqual(r["notes"][slip]["status"], "wrong_pitch")
        ev = next(e for e in r["summary"]["scoreCheck"]["evidence"] if e["kind"] == "score_doubtful")
        self.assertEqual((ev["measures"], ev["reasons"]), ([4], ["reading_sides_with_take"]))
        self.assertTrue(r["summary"]["scoreCheck"]["secondReading"])

    def test_overtone_extra_is_not_counted(self):
        # The transcriber reports a key an octave above a played note, which the audio cannot rule out.
        xml = grand_xml(self.measures)
        notes = parse_piano_score(xml)
        events = take(notes)
        wav, _sig = piano_audio(events, events[-1][0] + 2)
        on20, m20 = events[20]
        perf = sorted([(on, on + 0.4, float(m), 80.0) for on, m in events] + [(on20 + 0.01, on20 + 0.3, float(m20 + 12), 50.0)])
        real = piano_engine._check
        # As on a real piano, the audio check cannot rule the octave key out: its partials are all there.
        fake = lambda model, midi, t, masked: (0.9, "heard") if midi == m20 + 12 else real(model, midi, t, masked)
        with patch.object(piano_engine, "_check", fake):
            r = piano_engine.analyze_piano(wav, xml, 120, 1, perf=perf)
        x = next(e for e in r["extras"] if e["midi"] == m20 + 12)
        self.assertEqual((x["counted"], x["reason"]), (False, "overtone"))
        self.assertEqual(r["summary"]["extraNotes"], 0)


if __name__ == "__main__":
    unittest.main()
