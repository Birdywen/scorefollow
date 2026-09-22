"""Ground Truth Regression Test - Compare v6 algorithm against human-annotated timing.

Usage: 
  python3 scripts/ground-truth-regression.py
  
Requires:
  - Parsed preload JSON in /home/ubuntu/workspace/PDF_TO_TEST/*_parsed.json
  - Corresponding PDFs in benchmarks/gpu/{score}/
  
Output:
  - benchmarks/ground-truth-report.json
  - Console summary with per-score TP/FP/FN
"""
import json
import sys
from pathlib import Path
from collections import defaultdict

root = Path(__file__).resolve().parents[1]
preload_dir = Path('/home/ubuntu/workspace/PDF_TO_TEST')
gpu_dir = root / 'benchmarks' / 'gpu'

# Mapping: preload filename stem -> GPU benchmark directory name
SCORE_MAP = {
    'Arpeggione_Sonata': 'arpeggione_sonata',
    'Saint-Preux_-_Le_Reve': 'saint-preux_-_le_reve',
    'Serenade_vl_pf': 'serenade_vl_pf',
    'Suzuki-Book3-3-4': 'suzuki-book3-3-4',
    'Tschaikowsky_Rococo_Grümmer_Cello': 'tschaikowsky_rococo_gru_mmer_cello',
    'kupdf.net_suzuki-cello-school-vol-3-piano-accompanimentpdf_4': 'kupdf_net_suzuki-cello-school-vol-3-piano-accomp',
    'swan_cello_melody': 'swan_cello_melody',
    'vivaldi-bajazet-sposa-son-disprezzata-aria-irenepdf': 'vivaldi-bajazet-sposa-son-disprezzata-aria-irene',
    'yradier_c_la_paloma_piano_beg': 'yradier_c_la_paloma_piano_beg',
}

TOL_PX = 4  # Tolerance in pixels (width=1000 coordinate space)

print("=" * 80)
print("GROUND TRUTH REGRESSION TEST - v6 Algorithm vs Human Annotation")
print("=" * 80)
print()
print("Loading human-annotated timing from synpdf preload.js files...")
print(f"Preload directory: {preload_dir}")
print(f"GPU benchmark directory: {gpu_dir}")
print()

results = []
total_tp = total_fp = total_fn = 0
total_ref = 0

for preload_stem, score_dir_name in SCORE_MAP.items():
    parsed_path = preload_dir / f'{preload_stem}_parsed.json'
    if not parsed_path.exists():
        print(f"SKIP {preload_stem}: no parsed JSON")
        continue
    
    gt_data = json.loads(parsed_path.read_text())
    gt_timing = gt_data['timing']
    
    score_dir = gpu_dir / score_dir_name
    if not score_dir.exists():
        print(f"SKIP {preload_stem}: GPU data not found at {score_dir}")
        continue
    
    ours_path = score_dir / 'ours.json'
    if not ours_path.exists():
        print(f"SKIP {preload_stem}: no ours.json (run homr-dump.mjs first)")
        continue
    
    ours = json.loads(ours_path.read_text())
    
    # Extract bar positions from ours.json (flattened across all systems, all pages)
    detected_bars = []
    for page in ours['pages']:
        for sys_bars in page['bars']:
            # Internal bars only (exclude endpoints at index 0 and -1)
            detected_bars.extend(sys_bars[1:-1])
    
    detected_bars = sorted(detected_bars)
    gt_bars = sorted([t['x'] for t in gt_timing])
    
    # Match within tolerance
    used_det = [False] * len(detected_bars)
    tp = 0
    dev_sum = 0
    miss = []
    
    for gt_x in gt_bars:
        best_i = -1
        best_dist = float('inf')
        for i, det_x in enumerate(detected_bars):
            if used_det[i]:
                continue
            dist = abs(det_x - gt_x)
            if dist <= TOL_PX and dist < best_dist:
                best_dist = dist
                best_i = i
        
        if best_i >= 0:
            used_det[best_i] = True
            tp += 1
            dev_sum += best_dist
        else:
            miss.append(round(gt_x))
    
    extra = [round(detected_bars[i]) for i, used in enumerate(used_det) if not used]
    fp = len(extra)
    fn = len(miss)
    mean_dev = (dev_sum / tp) if tp else 0
    
    total_tp += tp
    total_fp += fp
    total_fn += fn
    total_ref += len(gt_bars)
    
    results.append({
        'score': score_dir_name,
        'preload': preload_stem,
        'reference_count': len(gt_bars),
        'detected_count': len(detected_bars),
        'tp': tp,
        'fp': fp,
        'fn': fn,
        'mean_deviation': round(mean_dev, 2),
        'miss': miss[:10],  # truncate for readability
        'extra': extra[:10],
    })
    
    print(f"{score_dir_name:45s} ref={len(gt_bars):>3d} det={len(detected_bars):>3d} | TP={tp:>3d} FP={fp:>3d} FN={fn:>3d} | dev={mean_dev:.2f}")

print()
print("=" * 80)
print(f"TOTAL: ref={total_ref} | TP={total_tp} FP={total_fp} FN={total_fn}")
print(f"Precision: {total_tp / max(1, total_tp + total_fp):.3f}")
print(f"Recall:    {total_tp / max(1, total_tp + total_fn):.3f}")
print("=" * 80)

report_path = root / 'benchmarks' / 'ground-truth-report.json'
report_path.write_text(json.dumps({
    'evaluator': 'ground-truth',
    'algorithm_version': 6,
    'tolerance_px': TOL_PX,
    'totals': {
        'tp': total_tp,
        'fp': total_fp,
        'fn': total_fn,
        'reference_count': total_ref,
        'precision': round(total_tp / max(1, total_tp + total_fp), 3),
        'recall': round(total_tp / max(1, total_tp + total_fn), 3),
    },
    'results': results,
}, indent=2))

print()
print(f"Report saved: {report_path}")
print()
print("NEXT STEPS:")
print("1. Review miss/extra coordinates in the report")
print("2. Investigate high FP/FN scores")
print("3. Design next feature iteration based on failure patterns")
print("4. Add this test to CI: pytest scripts/test_ground_truth.py")
