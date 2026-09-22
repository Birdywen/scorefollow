import json
from pathlib import Path
gt_root = Path('/home/ubuntu/n/scorefollow/benchmarks/gt')
gpu_root = Path('/home/ubuntu/n/scorefollow/benchmarks/gpu')

def match_systems(gt_sys, our_sys):
    pairs = []
    used_o = set()
    for gi, g in enumerate(gt_sys):
        if 'cs' not in g or not g.get('cs'):
            pairs.append((gi, None))
            continue
        best = -1; best_ov = 0
        for oi, o in enumerate(our_sys):
            if oi in used_o: continue
            g1, g2 = g['cs'][0], g['cs'][-1]
            o1, o2 = o['y1'], o['y2']
            ov = max(0, min(g2, o2) - max(g1, o1)) / max(1, g2 - g1)
            if ov > best_ov:
                best_ov = ov; best = oi
        if best >= 0 and best_ov > 0.5:
            pairs.append((gi, best)); used_o.add(best)
        else:
            pairs.append((gi, None))
    return pairs, used_o

TOL = 4
tot_tp = tot_fp = tot_fn = 0
tot_gt = tot_our = 0
rows = []
for gtfile, score in [
    ('Arpeggione_Sonata.json', 'arpeggione_sonata'),
    ('Saint-Preux_-_Le_Reve.json', 'saint-preux_-_le_reve'),
    ('Serenade_vl_pf.json', 'serenade_vl_pf'),
    ('Suzuki-Book3-3-4.json', 'suzuki-book3-3-4'),
    ('kupdf.net_suzuki-cello-school-vol-3-piano-accompanimentpdf_4.json', 'kupdf_net_suzuki-cello-school-vol-3-piano-accomp'),
    ('swan_cello_melody.json', 'swan_cello_melody'),
    ('vivaldi-bajazet-sposa-son-disprezzata-aria-irenepdf.json', 'vivaldi-bajazet-sposa-son-disprezzata-aria-irene'),
    ('yradier_c_la_paloma_piano_beg.json', 'yradier_c_la_paloma_piano_beg'),
    (str(next(Path('/home/ubuntu/n/scorefollow/benchmarks/gt').glob('Tschaikowsky*')).name), 'tschaikowsky_rococo_gru_mmer_cello'),
]:
    gt = json.loads((gt_root / gtfile).read_text())
    ours = json.loads((gpu_root / score / 'ours.json').read_text())
    sc_tp = sc_fp = sc_fn = 0
    for gpi, op in zip(gt['pages'], ours['pages']):
        g_sys = gpi['systems']; o_sys = op['systems']
        tot_gt += len(g_sys); tot_our += len(o_sys)
        pairs, used_o = match_systems(g_sys, o_sys)
        for gi, oi in pairs:
            if oi is None:
                sc_fn += max(0, len(gpi['bars'][gi]) - 2)
                continue
            want = gpi['bars'][gi][1:-1]
            internal = ours['pages'][gpi['page']-1]['bars'][oi][1:-1]
            used = [False]*len(internal)
            for w in want:
                found = -1
                for ii, d in enumerate(internal):
                    if used[ii]:
                        continue
                    if abs(d - w) <= TOL:
                        found = ii
                        break
                if found >= 0:
                    used[found] = True; sc_tp += 1
                else:
                    sc_fn += 1
            sc_fp += sum(1 for u in used if not u)
        for oi in range(len(o_sys)):
            if oi not in used_o:
                sc_fp += max(0, len(ours['pages'][gpi['page']-1]['bars'][oi]) - 2)
    tot_tp += sc_tp; tot_fp += sc_fp; tot_fn += sc_fn
    rows.append((score, sc_tp, sc_fp, sc_fn))

print(f'{"score":48s} {"tp":>4s} {"fp":>4s} {"fn":>4s}')
for r in rows:
    print(f'{r[0]:48s} {r[1]:>4d} {r[2]:>4d} {r[3]:>4d}')
print(f'{"TOTAL":48s} {tot_tp:>4d} {tot_fp:>4d} {tot_fn:>4d}')
print(f'gt_sys={tot_gt} our_sys={tot_our} | ref_bars={tot_tp+tot_fn}')
print(f'precision={tot_tp/max(1,tot_tp+tot_fp):.3f} recall={tot_tp/max(1,tot_tp+tot_fn):.3f}')
