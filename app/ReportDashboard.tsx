'use client';
import { useMemo, useRef, useState } from 'react';
import s from './report.module.css';

// 演奏报告面板: 音高四色分级 + 多种图表 + 导出 PDF/网页。纯 SVG, 无图表依赖。
export type Grade = 'green' | 'orange' | 'purple' | 'red' | 'none';
export type DashNote = {
  id: string;
  measure: number;
  pitchErrorCents?: number | null;
  pitchExcluded?: boolean;
  timingErrorMs?: number | null;
  status?: string;
  timingStatus?: string;
};
export type DashMeta = {
  title?: string;
  date?: Date | string | number;
  instrument?: string;
  bpm?: number | null;
  durationSec?: number | null;
  version?: string;
};
type Props = {
  zh?: boolean;
  notes: DashNote[];
  scores: { overall?: number | null; pitch?: number | null; rhythm?: number | null };
  meta: DashMeta;
  notices?: string[];
  scoreMeasureCount?: number;
  onNoteClick?: (note: DashNote) => void;
  onMeasureClick?: (measure: number) => void;
};

export const GRADES: Grade[] = ['green', 'orange', 'purple', 'red', 'none'];
export const GRADE_COLOR: Record<Grade, string> = { green: '#1f9d61', orange: '#f08c00', purple: '#8b5cf6', red: '#e03e3e', none: '#b4b8c0' };
const GRADE_ZH: Record<Grade, [string, string]> = {
  green: ['准', '25 音分以内'],
  orange: ['稍有偏差', '25–50 音分'],
  purple: ['明显偏差', '50–100 音分'],
  red: ['偏差很大', '超过 100 音分（半个音以上）'],
  none: ['没听清', '录音里没检测到这个音'],
};
const GRADE_EN: Record<Grade, [string, string]> = {
  green: ['In tune', 'within 25 cents'],
  orange: ['Slightly off', '25–50 cents'],
  purple: ['Clearly off', '50–100 cents'],
  red: ['Far off', 'over 100 cents'],
  none: ['Not detected', 'no clear pitch heard'],
};
const PITCH_W: Record<Grade, number> = { green: 0, orange: 1, purple: 2, red: 3, none: 0 };
const TIME_W: Record<Grade, number> = { green: 0, orange: 1, purple: 1.5, red: 2, none: 0 };
const INSTRUMENT_ZH: Record<string, string> = { violin: '小提琴', viola: '中提琴', cello: '大提琴', bass: '低音提琴', piano: '钢琴' };

export function pitchGrade(cents?: number | null): Grade {
  if (cents == null || !Number.isFinite(cents)) return 'none';
  const a = Math.abs(cents);
  return a <= 25 ? 'green' : a <= 50 ? 'orange' : a <= 100 ? 'purple' : 'red';
}
export function timingGrade(ms?: number | null): Grade {
  if (ms == null || !Number.isFinite(ms)) return 'none';
  const a = Math.abs(ms);
  return a <= 50 ? 'green' : a <= 100 ? 'orange' : a <= 160 ? 'purple' : 'red';
}
const gl = (g: Grade, zh: boolean) => (zh ? GRADE_ZH : GRADE_EN)[g][0];
const emptyCounts = (): Record<Grade, number> => ({ green: 0, orange: 0, purple: 0, red: 0, none: 0 });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const scoreColor = (v?: number | null) => (v == null ? GRADE_COLOR.none : v >= 85 ? GRADE_COLOR.green : v >= 70 ? GRADE_COLOR.orange : v >= 50 ? GRADE_COLOR.purple : GRADE_COLOR.red);
function scoreWord(v: number | null | undefined, zh: boolean): string {
  if (v == null) return zh ? '未计算' : 'n/a';
  if (v >= 90) return zh ? '非常棒' : 'Excellent';
  if (v >= 80) return zh ? '很好' : 'Great';
  if (v >= 70) return zh ? '不错' : 'Good';
  if (v >= 60) return zh ? '继续加油' : 'Keep going';
  return zh ? '需要多练' : 'Needs work';
}
function fmtDate(d?: Date | string | number): string {
  const x = d == null ? new Date() : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}
function fmtDur(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const t = Math.round(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

type MeasureRow = { measure: number; counts: Record<Grade, number>; total: number; badness: number; offCents: number[]; offMs: number[]; covered: boolean };

function reason(r: MeasureRow, zh: boolean): string {
  const parts: string[] = [];
  if (r.offCents.length) {
    const sharp = r.offCents.filter((c) => c > 0).length;
    const mag = Math.round(r.offCents.reduce((a, c) => a + Math.abs(c), 0) / r.offCents.length);
    const dir = sharp * 2 >= r.offCents.length ? (zh ? '偏高' : 'sharp') : (zh ? '偏低' : 'flat');
    parts.push(zh ? `${r.offCents.length} 个音${dir}（约 ${mag} 音分）` : `${r.offCents.length} note(s) ${dir} (~${mag} cents)`);
  }
  if (r.offMs.length) {
    const early = r.offMs.filter((m) => m < 0).length;
    const mag = Math.round(r.offMs.reduce((a, m) => a + Math.abs(m), 0) / r.offMs.length);
    const dir = early * 2 > r.offMs.length ? (zh ? '抢拍' : 'early') : (zh ? '拖拍' : 'late');
    parts.push(zh ? `${r.offMs.length} 个音${dir}（约 ${mag} 毫秒）` : `${r.offMs.length} note(s) ${dir} (~${mag} ms)`);
  }
  if (!parts.length && r.counts.none) parts.push(zh ? `${r.counts.none} 个音没听清` : `${r.counts.none} unclear note(s)`);
  return parts.join(zh ? '，' : ', ');
}

function Ring({ value, label, word }: { value?: number | null; label: string; word: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : clamp(value, 0, 100);
  const color = scoreColor(value);
  return <figure className={s.ring}>
    <svg viewBox='0 0 100 100' className={s.ringSvg} role='img' aria-label={`${label} ${value ?? '—'}`}>
      <circle cx='50' cy='50' r={r} fill='none' stroke='#edf0f4' strokeWidth='9' />
      {v > 0 && <circle cx='50' cy='50' r={r} fill='none' stroke={color} strokeWidth='9' strokeLinecap='round' strokeDasharray={`${(c * v) / 100} ${c}`} transform='rotate(-90 50 50)' />}
      <text x='50' y='46' textAnchor='middle' dominantBaseline='central' className={s.ringNum}>{value ?? '—'}</text>
      <text x='50' y='68' textAnchor='middle' className={s.ringWord} style={{ fill: color }}>{word}</text>
    </svg>
    <figcaption>{label}</figcaption>
  </figure>;
}

function Donut({ counts, total, top, sub }: { counts: Record<Grade, number>; total: number; top: string; sub: string }) {
  const r = 38;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return <svg viewBox='0 0 100 100' className={s.donut} role='img' aria-label={`${sub} ${top}`}>
    <circle cx='50' cy='50' r={r} fill='none' stroke='#edf0f4' strokeWidth='14' />
    {total > 0 && GRADES.map((g) => {
      const len = (c * counts[g]) / total;
      if (len <= 0) return null;
      const el = <circle key={g} cx='50' cy='50' r={r} fill='none' stroke={GRADE_COLOR[g]} strokeWidth='14' strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-acc} transform='rotate(-90 50 50)'><title>{String(counts[g])}</title></circle>;
      acc += len;
      return el;
    })}
    <text x='50' y='48' textAnchor='middle' dominantBaseline='central' className={s.donutTop}>{top}</text>
    <text x='50' y='63' textAnchor='middle' className={s.donutSub}>{sub}</text>
  </svg>;
}

function MeasureBars({ rows, zh, onMeasureClick }: { rows: MeasureRow[]; zh: boolean; onMeasureClick?: (m: number) => void }) {
  const W = 640, H = 200, L = 28, B = 22, T = 8;
  const n = Math.max(rows.length, 1);
  const bw = (W - L) / n;
  const max = Math.max(1, ...rows.map((r) => r.total));
  const step = Math.max(1, Math.ceil(n / 16));
  const ph = H - B - T;
  return <svg viewBox={`0 0 ${W} ${H}`} className={s.chart} role='img' aria-label={zh ? '每小节音准' : 'Pitch by bar'}>
    {[0, 0.5, 1].map((f) => <g key={f}>
      <line x1={L} x2={W} y1={T + ph * (1 - f)} y2={T + ph * (1 - f)} stroke='#eceef2' />
      <text x={L - 6} y={T + ph * (1 - f) + 4} textAnchor='end'>{Math.round(max * f)}</text>
    </g>)}
    {rows.map((r, i) => {
      let y = T + ph;
      const x = L + i * bw;
      const tip = `${zh ? `第 ${r.measure} 小节` : `Bar ${r.measure}`}: ${GRADES.filter((g) => r.counts[g] > 0).map((g) => `${gl(g, zh)} ${r.counts[g]}`).join(' · ')}`;
      return <g key={r.measure} className={onMeasureClick && r.covered ? s.clickable : undefined} onClick={r.covered ? () => onMeasureClick?.(r.measure) : undefined}>
        <title>{r.covered ? tip : (zh ? `第 ${r.measure} 小节：这次没录到` : `Bar ${r.measure}: not recorded`)}</title>
        <rect x={x} y={T} width={bw} height={ph} fill='transparent' />
        {!r.covered && <rect x={x + bw * 0.12} y={T + ph - 5} width={Math.max(1, bw * 0.76)} height={5} rx={2} fill='#e3e6eb' />}
        {GRADES.map((g) => {
          const h = (ph * r.counts[g]) / max;
          if (h <= 0) return null;
          y -= h;
          return <rect key={g} x={x + bw * 0.12} y={y} width={Math.max(1, bw * 0.76)} height={h} fill={GRADE_COLOR[g]} />;
        })}
        {i % step === 0 && <text x={x + bw / 2} y={H - 6} textAnchor='middle'>{r.measure}</text>}
      </g>;
    })}
  </svg>;
}

function PitchScatter({ notes, zh, onNoteClick }: { notes: DashNote[]; zh: boolean; onNoteClick?: (n: DashNote) => void }) {
  const W = 720, H = 220, L = 34, R = 8, mid = 110, span = 96, LIM = 150;
  const n = Math.max(notes.length, 1);
  const dx = (W - L - R) / n;
  const yFor = (c: number) => mid - (clamp(c, -LIM, LIM) / LIM) * span;
  const bands: [number, Grade][] = [[100, 'purple'], [50, 'orange'], [25, 'green']];
  return <svg viewBox={`0 0 ${W} ${H}`} className={s.chart} role='img' aria-label={zh ? '音高走势' : 'Pitch along the piece'}>
    {bands.map(([c, g]) => <rect key={g} x={L} width={W - L - R} y={yFor(c)} height={yFor(-c) - yFor(c)} fill={GRADE_COLOR[g]} opacity={0.08} />)}
    <line x1={L} x2={W - R} y1={mid} y2={mid} stroke={GRADE_COLOR.green} strokeOpacity={0.6} strokeDasharray='4 4' />
    {[100, 50, -50, -100].map((c) => <text key={c} x={L - 4} y={yFor(c) + 4} textAnchor='end'>{c > 0 ? `+${c}` : c}</text>)}
    <text x={L - 4} y={mid + 4} textAnchor='end'>0</text>
    <text x={L + 6} y={16}>{zh ? '↑ 偏高' : '↑ sharp'}</text>
    <text x={L + 6} y={H - 6}>{zh ? '↓ 偏低' : '↓ flat'}</text>
    {notes.map((note, i) => {
      const c = note.pitchErrorCents;
      const g = note.pitchExcluded ? 'none' : pitchGrade(c);
      const x = L + dx * (i + 0.5);
      const y = g === 'none' || c == null ? mid : yFor(c);
      const tip = `${zh ? '小节' : 'Bar'} ${note.measure} · ${g === 'none' || c == null ? gl('none', zh) : `${c > 0 ? '+' : ''}${Math.round(c)} ${zh ? '音分' : 'cents'}`}`;
      return <circle key={note.id} cx={x} cy={y} r={g === 'none' ? 2.6 : 3.6} fill={g === 'none' ? 'none' : GRADE_COLOR[g]} stroke={GRADE_COLOR[g]} strokeWidth={g === 'none' ? 1.2 : 0} className={onNoteClick ? s.clickable : undefined} onClick={() => onNoteClick?.(note)}><title>{tip}</title></circle>;
    })}
  </svg>;
}

function TimingHistogram({ notes, zh }: { notes: DashNote[]; zh: boolean }) {
  const STEP = 25, LIM = 200;
  const nb = (2 * LIM) / STEP;
  const bins = new Array<number>(nb).fill(0);
  for (const note of notes) {
    const ms = note.timingErrorMs;
    if (ms == null || !Number.isFinite(ms)) continue;
    bins[Math.min(nb - 1, Math.floor((clamp(ms, -LIM, LIM - 1) + LIM) / STEP))] += 1;
  }
  const W = 640, H = 180, L = 10, B = 34, T = 10;
  const ph = H - B - T;
  const bw = (W - 2 * L) / nb;
  const max = Math.max(1, ...bins);
  const xFor = (v: number) => L + ((v + LIM) / (2 * LIM)) * (W - 2 * L);
  return <svg viewBox={`0 0 ${W} ${H}`} className={s.chart} role='img' aria-label={zh ? '起音早晚分布' : 'Early / late distribution'}>
    {bins.map((v, i) => {
      const center = -LIM + STEP * (i + 0.5);
      const h = (ph * v) / max;
      return <rect key={i} x={L + i * bw + 2} y={T + ph - Math.max(h, v ? 2 : 0)} width={bw - 4} height={Math.max(h, v ? 2 : 0)} rx={3} fill={GRADE_COLOR[timingGrade(center)]}><title>{`${center - STEP / 2} ~ ${center + STEP / 2} ms: ${v}`}</title></rect>;
    })}
    <line x1={W / 2} x2={W / 2} y1={T} y2={T + ph} stroke='#1d2330' strokeOpacity={0.35} strokeDasharray='3 3' />
    <text x={W / 2} y={H - 18} textAnchor='middle'>{zh ? '正好' : 'on time'}</text>
    <text x={L} y={H - 18}>{zh ? '← 抢拍（早）' : '← early'}</text>
    <text x={W - L} y={H - 18} textAnchor='end'>{zh ? '拖拍（晚）→' : 'late →'}</text>
    {[-200, -100, 100, 200].map((v) => <text key={v} x={xFor(v)} y={H - 3} textAnchor={v === -200 ? 'start' : v === 200 ? 'end' : 'middle'}>{`${v > 0 ? '+' : ''}${v} ms`}</text>)}
  </svg>;
}

const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function collectCss(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) out.push(rule.cssText);
    } catch {
      // 跨域样式表读不到, 跳过
    }
  }
  return out.join(' ');
}
function buildHtml(node: HTMLElement, title: string): string {
  const extra = '@page{size:A4;margin:12mm}body{margin:0;background:#fff}[data-noprint]{display:none!important}';
  return `<!doctype html><html lang='zh'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>${escHtml(title)}</title><style>${collectCss()}${extra}</style></head><body>${node.outerHTML}</body></html>`;
}

export default function ReportDashboard({ zh = true, notes, scores, meta, notices = [], scoreMeasureCount, onNoteClick, onMeasureClick }: Props) {
  const t = (a: string, b: string) => (zh ? a : b);
  const ref = useRef<HTMLDivElement>(null);
  const [exportMsg, setExportMsg] = useState('');
  const dateStr = fmtDate(meta.date);
  const title = meta.title?.trim() || t('未命名曲目', 'Untitled piece');
  const fileBase = `${t('练习报告', 'report')}-${title}-${dateStr.slice(0, 10) || 'today'}`.split('/').join('-').split(':').join('-');

  const stats = useMemo(() => {
    const counts = emptyCounts();
    const byMeasure = new Map<number, MeasureRow>();
    let onBeat = 0;
    let early = 0;
    let late = 0;
    for (const note of notes) {
      const g = note.pitchExcluded ? 'none' : pitchGrade(note.pitchErrorCents);
      const tg = timingGrade(note.timingErrorMs);
      counts[g] += 1;
      if (tg !== 'none') {
        if (tg === 'green') onBeat += 1;
        else if ((note.timingErrorMs ?? 0) < 0) early += 1;
        else late += 1;
      }
      const m = Number.isFinite(note.measure) ? note.measure : 0;
      let row = byMeasure.get(m);
      if (!row) {
        row = { measure: m, counts: emptyCounts(), total: 0, badness: 0, offCents: [], offMs: [], covered: true };
        byMeasure.set(m, row);
      }
      row.counts[g] += 1;
      row.total += 1;
      row.badness += PITCH_W[g] + TIME_W[tg];
      if (PITCH_W[g] > 0 && note.pitchErrorCents != null) row.offCents.push(note.pitchErrorCents);
      if (TIME_W[tg] > 0 && note.timingErrorMs != null) row.offMs.push(note.timingErrorMs);
    }
    if (scoreMeasureCount != null && scoreMeasureCount >= 1) {
      for (let m = 1; m <= Math.min(scoreMeasureCount, 999); m += 1) if (!byMeasure.has(m)) byMeasure.set(m, { measure: m, counts: emptyCounts(), total: 0, badness: 0, offCents: [], offMs: [], covered: false });
    }
    const rows = Array.from(byMeasure.values()).sort((a, b) => a.measure - b.measure);
    const practice = rows.filter((r) => r.badness >= 2).sort((a, b) => b.badness - a.badness || a.measure - b.measure).slice(0, 5);
    return { counts, rows, practice, onBeat, early, late, detected: notes.length - counts.none, uncovered: rows.filter((r) => !r.covered).length, coveredFrom: rows.find((r) => r.covered)?.measure, coveredTo: [...rows].reverse().find((r) => r.covered)?.measure };
  }, [notes, scoreMeasureCount]);

  const greenPct = stats.detected ? Math.round((100 * stats.counts.green) / stats.detected) : 0;
  const top = stats.practice.map((r) => r.measure).sort((a, b) => a - b);
  const summary = zh
    ? `这一遍一共分析了 ${notes.length} 个音，其中 ${stats.counts.green} 个音很准（占能听清的音的 ${greenPct}%）。` + (top.length ? `建议重点练习第 ${top.join('、')} 小节。` : '没有特别需要单独练的小节，继续保持！')
    : `${notes.length} notes analysed; ${stats.counts.green} in tune (${greenPct}% of detected notes). ` + (top.length ? `Focus on bar(s) ${top.join(', ')}.` : 'No bar needs special work, keep it up!');

  const exportPdf = () => {
    if (!ref.current) return;
    const w = window.open('', '_blank');
    if (!w) {
      setExportMsg(t('浏览器拦截了弹窗：请允许弹出窗口后再试，或者用“保存网页版”。', 'Pop-up blocked: allow pop-ups, or use Save web page.'));
      return;
    }
    w.document.open();
    w.document.write(buildHtml(ref.current, fileBase));
    w.document.close();
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      w.focus();
      w.print();
    };
    w.addEventListener('load', go);
    window.setTimeout(go, 900);
    setExportMsg(t('已打开打印窗口：“目标打印机”选“另存为 PDF”就能保存。', 'Print dialog opened: choose Save as PDF.'));
  };
  const exportHtml = () => {
    if (!ref.current) return;
    const blob = new Blob([buildHtml(ref.current, fileBase)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBase}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    setExportMsg(t('网页版报告已下载，可以直接发给老师，用任何浏览器打开。', 'Downloaded; open it in any browser.'));
  };

  const G = zh ? GRADE_ZH : GRADE_EN;
  return <div ref={ref} className={s.report}>
    <header className={s.head}>
      <div>
        <h2 className={s.title}>{t('练习报告', 'Practice report')} · {title}</h2>
        <div className={s.meta}>
          <span>{t('日期', 'Date')} <b>{dateStr || '—'}</b></span>
          {meta.instrument && <span>{t('乐器', 'Instrument')} <b>{zh ? INSTRUMENT_ZH[meta.instrument] ?? meta.instrument : meta.instrument}</b></span>}
          {meta.bpm != null && Number.isFinite(meta.bpm) && <span>{t('速度', 'Tempo')} <b>{Math.round(meta.bpm)} BPM</b></span>}
          <span>{t('时长', 'Length')} <b>{fmtDur(meta.durationSec)}</b></span>
          <span>{t('音符', 'Notes')} <b>{notes.length}</b></span>
        </div>
      </div>
      <div className={s.actions} data-noprint=''>
        <button type='button' className={s.btn} onClick={exportPdf}>{t('导出 PDF', 'Export PDF')}</button>
        <button type='button' className={`${s.btn} ${s.ghost}`} onClick={exportHtml}>{t('保存网页版', 'Save web page')}</button>
      </div>
    </header>
    {exportMsg && <p className={s.exportMsg} data-noprint='' role='status'>{exportMsg}</p>}

    <section className={s.card}>
      <div className={s.rings}>
        <Ring value={scores.overall} label={t('综合', 'Overall')} word={scoreWord(scores.overall, zh)} />
        <Ring value={scores.pitch} label={t('音准', 'Pitch')} word={scoreWord(scores.pitch, zh)} />
        <Ring value={scores.rhythm} label={t('节奏', 'Rhythm')} word={scoreWord(scores.rhythm, zh)} />
      </div>
      <p className={s.summary}>{summary}{stats.uncovered > 0 && stats.coveredFrom != null ? t(` 这次录音覆盖第 ${stats.coveredFrom}–${stats.coveredTo} 小节，全曲共 ${scoreMeasureCount} 小节。`, ` This take covers bars ${stats.coveredFrom}–${stats.coveredTo} of ${scoreMeasureCount}.`) : ''}</p>
    </section>

    {notices.length > 0 && <section className={s.notice}>{notices.map((text) => <p key={text}>{text}</p>)}</section>}

    <div className={s.grid2}>
      <section className={s.card}>
        <h3>{t('音准分布', 'Pitch accuracy')}</h3>
        <p className={s.sub}>{t('每个音按偏离程度分成不同颜色', 'Each note coloured by how far off it was')}</p>
        <Donut counts={stats.counts} total={notes.length} top={`${greenPct}%`} sub={t('音很准', 'in tune')} />
        <ul className={s.legend}>{GRADES.map((g) => <li key={g}>
          <span className={s.dot} style={{ background: GRADE_COLOR[g] }} />
          <span><b>{G[g][0]}</b><small>{G[g][1]}</small></span>
          <span className={s.n}>{stats.counts[g]}</span>
        </li>)}</ul>
      </section>
      <section className={s.card}>
        <h3>{t('每个小节的音准', 'Pitch by bar')}</h3>
        <p className={s.sub}>{t('柱子越绿越好；点一下柱子可以回听这一小节', 'Greener is better; click a bar to replay it')}{stats.uncovered > 0 ? t('；底部灰色短条是这次没录到的小节', '; grey stubs are bars not recorded') : ''}</p>
        <MeasureBars rows={stats.rows} zh={zh} onMeasureClick={onMeasureClick} />
      </section>
    </div>

    <section className={s.card}>
      <h3>{t('音高走势', 'Pitch along the piece')}</h3>
      <p className={s.sub}>{t('每个点是一个音：越靠近中间的虚线越准，在上面是偏高，在下面是偏低。点一下可以回听。', 'Each dot is a note: near the middle line is in tune, above is sharp, below is flat. Click to replay.')}</p>
      <PitchScatter notes={notes} zh={zh} onNoteClick={onNoteClick} />
    </section>

    <section className={s.card}>
      <h3>{t('节奏：拉早了还是拉晚了？', 'Rhythm: early or late?')}</h3>
      <p className={s.sub}>{t('中间是正好踩在拍子上；左边是抢拍（拉早了），右边是拖拍（拉晚了）。早晚 50 毫秒以内都算踩准。', 'Middle is on the beat; left is early, right is late. Within 50 ms counts as on the beat.')}</p>
      <div className={s.stats3}>
        <div><b style={{ color: GRADE_COLOR.green }}>{stats.onBeat}</b><span>{t('踩准拍子', 'On the beat')}</span></div>
        <div><b style={{ color: GRADE_COLOR.orange }}>{stats.early}</b><span>{t('抢拍', 'Early')}</span></div>
        <div><b style={{ color: GRADE_COLOR.purple }}>{stats.late}</b><span>{t('拖拍', 'Late')}</span></div>
      </div>
      <TimingHistogram notes={notes} zh={zh} />
    </section>

    <section className={s.card}>
      <h3>{t('今天最值得练的小节', 'Bars to practise')}</h3>
      {stats.practice.length === 0
        ? <p className={s.sub}>{t('没有明显的问题小节，很棒！', 'No problem bars, great job!')}</p>
        : <ol className={s.practice}>{stats.practice.map((r, i) => <li key={r.measure}>
          <button type='button' onClick={() => onMeasureClick?.(r.measure)}>
            <span className={s.rank}>{i + 1}</span>
            <span><b>{zh ? `第 ${r.measure} 小节` : `Bar ${r.measure}`}</b><br /><small>{reason(r, zh)}</small></span>
            <span className={s.mini}>{GRADES.map((g) => (r.counts[g] ? <i key={g} style={{ flex: r.counts[g], background: GRADE_COLOR[g] }} /> : null))}</span>
          </button>
        </li>)}</ol>}
    </section>

    <section className={`${s.card} ${s.glossary}`}>
      <h3>{t('怎么看这份报告', 'How to read this report')}</h3>
      <p><b>{t('音分', 'Cents')}</b>：{t('把一个半音平均分成 100 份，每份就是 1 音分。偏差在 25 音分以内，大多数人的耳朵几乎听不出来；超过 100 音分，就相当于拉成了旁边的另一个音。', 'A semitone is split into 100 cents. Within 25 cents is barely audible; over 100 cents is basically a different note.')}</p>
      <p><b>{t('毫秒', 'Milliseconds')}</b>：{t('1 秒 = 1000 毫秒。比拍子早或晚 50 毫秒以内都算踩准；超过 100 毫秒，听起来就会明显抢拍或拖拍。', '1 second = 1000 ms. Within 50 ms of the beat is on time; beyond 100 ms sounds clearly early or late.')}</p>
      <p><b>{t('灰色', 'Grey')}</b>：{t('录音里没能听清楚的音（比如太轻，或者被杂音盖住），不计入分数，不代表拉错了。', 'Notes the recording did not capture clearly; they are not scored and do not mean a mistake.')}</p>
    </section>
    <p className={s.foot}>ScoreFollow{meta.version ? ` · ${meta.version}` : ''} · {t('生成于', 'generated')} {fmtDate(new Date())}</p>
  </div>;
}
