import unittest

from .engine import parse_score
from .monophonic_xml import normalize_monophonic


def note(step='C', extra='', duration=1, voice=1):
    return f'<note>{extra}<pitch><step>{step}</step><octave>3</octave></pitch><duration>{duration}</duration><voice>{voice}</voice></note>'


def score(body):
    return '<score-partwise><part id="P1"><measure><attributes><divisions>1</divisions></attributes>' + body + '</measure></part></score-partwise>'


class MonophonicXmlTests(unittest.TestCase):
    def test_added_chord_tones_do_not_advance_time(self):
        xml, report = normalize_monophonic(score(note() + note('G', '<chord/>') + note('D')))
        parsed = parse_score(xml)
        self.assertEqual([(n['pitchMidi'], n['onsetBeat']) for n in parsed], [(48, 0), (50, 1)])
        self.assertEqual(report['removed_notes'][0]['reason'], 'chord-tone')

    def test_auxiliary_backup_voice_does_not_move_main_line(self):
        raw = score(note() + note('D') + '<backup><duration>2</duration></backup>' + note('G', duration=2, voice=2))
        xml, _ = normalize_monophonic(raw)
        self.assertEqual([n['pitchMidi'] for n in parse_score(xml)], [48, 50])
        self.assertEqual([n['onsetBeat'] for n in parse_score(xml)], [0, 1])

    def test_forward_gap_is_rest_not_compacted_time(self):
        xml, _ = normalize_monophonic(score(note() + '<forward><duration>2</duration></forward>' + note('D')))
        self.assertEqual(parse_score(xml)[1]['onsetBeat'], 3)

    def test_empty_part_and_namespace(self):
        raw = score(note()).replace('</score-partwise>', '<part id="P2"><measure><note><rest/><duration>4</duration></note></measure></part></score-partwise>')
        xml, report = normalize_monophonic(raw.replace('<score-partwise>', '<score-partwise xmlns="urn:test">'))
        self.assertEqual(len(parse_score(xml)), 1)
        self.assertEqual(report['removed_parts'], 1)

    def test_trailing_forward_preserves_next_measure_start(self):
        raw = score(note() + '<forward><duration>3</duration></forward>')
        raw = raw.replace('</part>', '<measure>' + note('D') + '</measure></part>')
        xml, _ = normalize_monophonic(raw)
        self.assertEqual(parse_score(xml)[1]['onsetBeat'], 4)

    def test_clean_line_unchanged_and_idempotent(self):
        raw = score(note() + note('D') + note('E'))
        xml, _ = normalize_monophonic(raw)
        again, _ = normalize_monophonic(xml)
        self.assertEqual(parse_score(raw), parse_score(xml))
        self.assertEqual(xml, again)

    def test_repeats_remain_explicit_not_silently_deleted(self):
        xml, _ = normalize_monophonic(score(note() + '<barline><repeat direction="backward"/></barline>'))
        with self.assertRaisesRegex(ValueError, '反复'):
            parse_score(xml)

    def test_orphan_tie_from_removed_chord_does_not_merge_other_pitch(self):
        raw = score(note() + note('G', '<chord/><tie type="start"/>') + note('G', '<tie type="stop"/>'))
        xml, report = normalize_monophonic(raw)
        self.assertEqual([n['pitchMidi'] for n in parse_score(xml)], [48, 55])
        self.assertEqual(len(report['removed_orphan_tie_stops']), 1)

    def test_retained_tie_keeps_duration(self):
        raw = score(note('C', '<tie type="start"/>') + note('C', '<tie type="stop"/>'))
        xml, report = normalize_monophonic(raw)
        self.assertEqual(parse_score(raw), parse_score(xml))
        self.assertEqual(report['removed_orphan_tie_stops'], [])


if __name__ == '__main__':
    unittest.main()
