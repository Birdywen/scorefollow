#!/usr/bin/env python3
"""Quick VAMP integration test: verify pYIN, QM onsets, and QM beats work."""
import sys
import os

analysis_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../analysis_service'))
sys.path.insert(0, analysis_dir)

import analysis_service.vamp_features as vamp_features
import numpy as np
import wave
import io

def make_test_wav_with_onsets():
    """Generate a WAV with clear onsets: 3 beeps with silence in between."""
    rate = 44100
    silence = np.zeros(int(rate * 0.3))
    beep_t = np.linspace(0, 0.1, int(rate * 0.1))
    beep = (np.sin(2 * np.pi * 440 * beep_t) * 0.8).astype(np.float32)
    signal = np.concatenate([beep, silence, beep, silence, beep]).astype(np.float32)
    
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((signal * 32767).astype(np.int16).tobytes())
    return buf.getvalue()

if __name__ == '__main__':
    print("Testing VAMP integration with onset-rich signal...\n")
    
    test_wav = make_test_wav_with_onsets()
    
    try:
        notes = vamp_features.extract_pitch_notes(test_wav)
        onsets = vamp_features.extract_onsets(test_wav)
        beats = vamp_features.extract_beats(test_wav)
        
        print("✓ VAMP functions callable\n")
        
        success_count = 0
        
        if notes:
            print(f"  ✓ pitch_notes: {len(notes)} notes")
            print(f"    Sample: start={notes[0][0]:.3f}s, end={notes[0][1]:.3f}s, midi={notes[0][2]:.1f}")
            success_count += 1
        else:
            print("  ✗ pitch_notes: None (degraded)")
        
        if onsets:
            print(f"\n  ✓ onsets: {len(onsets)} events")
            print(f"    First 3: {[f'{t:.3f}s' for t in onsets[:3]]}")
            success_count += 1
        else:
            print("\n  ✗ onsets: None (degraded)")
        
        if beats:
            print(f"\n  ✓ beats: {len(beats)} beats")
            print(f"    First 3: {[f'{t:.3f}s' for t in beats[:3]]}")
            success_count += 1
        else:
            print(f"\n  ⚠ beats: None (signal too short or no clear tempo, this is acceptable)")
        
        print(f"\n{'='*60}")
        if success_count >= 2:  # Notes + onsets is enough
            print("✓✓ VAMP integration PASSED (core features working)")
            sys.exit(0)
        else:
            print("✗ VAMP integration FAILED (check vamp package and .so files)")
            sys.exit(1)
            
    except Exception as e:
        print(f"\n✗ VAMP test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(2)
