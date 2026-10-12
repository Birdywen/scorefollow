"""Explicit single-line projection for known monophonic OCR inputs.

Choose the part and voice/staff with most non-chord pitched attacks (ties go
to document order). Keep the base note of each chord, never serialize added
chord tones as new beats. This is a deterministic projection, not OCR repair
ground truth. Original XML and the change report should be retained by callers.
"""
from collections import Counter
from decimal import Decimal
import xml.etree.ElementTree as ET

from .validation import validate_musicxml


def normalize_monophonic(xml: str) -> tuple[str, dict]:
    root = validate_musicxml(xml)
    if root.tag.rsplit('}', 1)[-1] != 'score-partwise':
        raise ValueError('仅支持 score-partwise MusicXML')
    parts = root.findall('./{*}part')
    if not parts:
        raise ValueError('MusicXML 缺少声部')
    ns = root.tag.split('}')[0] + '}' if root.tag.startswith('{') else ''
    tag = lambda name: ns + name
    pitched = lambda n: n.find('./{*}pitch') is not None and n.find('./{*}chord') is None
    part = max(parts, key=lambda p: sum(pitched(n) for n in p.findall('.//{*}note')))
    key = lambda n: (n.findtext('./{*}voice', '1'), n.findtext('./{*}staff', '1'))
    counts = Counter(key(n) for n in part.findall('.//{*}note') if pitched(n))
    if not counts:
        raise ValueError('MusicXML 没有可演奏音符')
    voice = counts.most_common(1)[0][0]
    report = {'policy': 'dominant-part-voice-base-chord-v1', 'part': part.get('id'),
              'voice_staff': list(voice), 'removed_parts': len(parts) - 1,
              'removed_notes': [], 'inserted_rests': [], 'timeline_elements_removed': 0,
              'removed_orphan_tie_stops': []}
    for other in parts:
        if other is not part:
            root.remove(other)
    part_list = root.find('./{*}part-list')
    if part_list is not None:
        for child in list(part_list):
            if child.tag.rsplit('}', 1)[-1] != 'score-part' or child.get('id') != part.get('id'):
                part_list.remove(child)
    active_tie = None
    for index, measure in enumerate(part.findall('./{*}measure'), 1):
        cursor = Decimal(0)
        previous_start = Decimal(0)
        forward_end = Decimal(0)
        events = []
        for child in list(measure):
            name = child.tag.rsplit('}', 1)[-1]
            if name in ('backup', 'forward'):
                duration = Decimal(child.findtext('./{*}duration', '0'))
                if not duration.is_finite() or duration < 0:
                    raise ValueError('MusicXML 时间轴时值无效')
                cursor += duration * (-1 if name == 'backup' else 1)
                if cursor < 0:
                    raise ValueError('MusicXML 时间轴越过小节起点')
                if name == 'forward' and key(child) == voice:
                    forward_end = max(forward_end, cursor)
                measure.remove(child)
                report['timeline_elements_removed'] += 1
            elif name == 'note':
                grace = child.find('./{*}grace') is not None
                chord = child.find('./{*}chord') is not None
                duration = Decimal(child.findtext('./{*}duration', '0')) if not grace else Decimal(0)
                if not duration.is_finite() or (not grace and duration <= 0):
                    raise ValueError('MusicXML 音符时值无效')
                start = previous_start if chord else cursor
                if not chord:
                    previous_start = start
                    cursor += duration
                measure.remove(child)
                reason = 'chord-tone' if chord else 'auxiliary-voice' if key(child) != voice else None
                if reason:
                    report['removed_notes'].append({'measure': index, 'reason': reason,
                        'pitch': ET.tostring(child.find('./{*}pitch'), encoding='unicode')
                                 if child.find('./{*}pitch') is not None else 'rest'})
                else:
                    events.append((start, duration, child))
        end = Decimal(0)
        for start, duration, note in sorted(events, key=lambda e: e[0]):
            if start < end:
                report['removed_notes'].append({'measure': index, 'reason': 'overlapping-base-note'})
                continue
            if start > end:
                active_tie = None
                rest = ET.Element(tag('note'))
                ET.SubElement(rest, tag('rest'))
                ET.SubElement(rest, tag('duration')).text = format(start - end, 'f')
                measure.append(rest)
                report['inserted_rests'].append({'measure': index, 'duration_units': str(start - end)})
            for name in ('voice', 'staff'):
                for item in note.findall('./{*}' + name):
                    note.remove(item)
            pitch = note.find('./{*}pitch')
            signature = tuple(pitch.findtext('./{*}' + k, '0' if k == 'alter' else '')
                              for k in ('step', 'alter', 'octave')) if pitch is not None else None
            ties = note.findall('./{*}tie')
            if any(t.get('type') == 'stop' for t in ties) and (signature is None or signature != active_tie):
                for parent in (note, note.find('./{*}notations')):
                    if parent is not None:
                        for item in list(parent):
                            if item.tag.rsplit('}', 1)[-1] in ('tie', 'tied') and item.get('type') == 'stop':
                                parent.remove(item)
                report['removed_orphan_tie_stops'].append({'measure': index, 'pitch': signature})
            active_tie = signature if any(t.get('type') == 'start' for t in ties) else None
            measure.append(note)
            end = start + duration
        if forward_end > end:
            rest = ET.Element(tag('note'))
            ET.SubElement(rest, tag('rest'))
            ET.SubElement(rest, tag('duration')).text = format(forward_end - end, 'f')
            measure.append(rest)
            active_tie = None
            report['inserted_rests'].append({'measure': index, 'duration_units': str(forward_end - end)})
    return ET.tostring(root, encoding='unicode'), report
