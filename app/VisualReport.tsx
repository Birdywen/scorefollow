"use client";

const PITCH_TOLERANCE_CENTS = 15;

export type VisualNote = {
  id: string;
  measure: number;
  pitchMidi?: number;
  pitchStatus?: string;
  pitchErrorCents: number | null;
  timingErrorMs?: number | null;
  status: string;
};

/** 模拟数据：8 小节约 40 个音，有准的、有偏高偏低的、有没听清的 */
export function makeMockNotes(): VisualNote[] {
  const cents: (number | null)[] = [
    5, -12, 8, 65, 20, -8, 3, null,
    10, -70, -15, 6, 12, 4, 88, -5,
    0, 15, -10, 7, null, -62, 9, 4,
    -6, 11, 75, -14, 5, 2,
    -9, 6, 12, -80, 8, 3, -4, 55, 10, -7,
  ];
  // 第一个音不计时（和真实后端一致）；其余有抢有拖、有没听清
  const timing: (number | null)[] = [
    null, 20, -30, 120, 45, -10, 5, 60,
    -95, 15, 30, -25, 110, 8, -12, 40,
    null, -55, 25, -15, 90, 35, -105, 12,
    18, -40, 70, -8, 22, -28,
    50, -65, 14, 130, -20, 6, -35, 48, -12, 26,
  ];
  return cents.map((c, i) => ({
    id: `mock-${i + 1}`,
    measure: Math.floor(i / 5) + 1,
    pitchErrorCents: c,
    timingErrorMs: timing[i] ?? null,
    status: c == null ? "uncertain" : Math.abs(c) > PITCH_TOLERANCE_CENTS ? "wrong_pitch" : "correct",
  }));
}

export type CompareTake = {
  name: string;
  pitch: number | null;
  rhythm: number | null;
};

/** 模拟三遍：一次比一次好，方便看对比图效果 */
export function makeMockTakes(): CompareTake[] {
  return [
    { name: "第 1 遍", pitch: 62, rhythm: 55 },
    { name: "第 2 遍", pitch: 74, rhythm: 68 },
    { name: "第 3 遍", pitch: 85, rhythm: 80 },
  ];
}

export function isScoredPitch(note: VisualNote): boolean {
  if (note.pitchErrorCents == null) return false;
  // Older services may label tracker excursions sharp/flat. Do not turn those
  // stale verdicts into red dots; keep display exclusions aligned with engine.
  const cents = note.pitchErrorCents;
  if (!Number.isFinite(cents) || Math.abs(cents) > 1200 || Math.abs(Math.abs(cents) - 1200) <= 80) return false;
  if (note.pitchMidi != null) {
    const detected = note.pitchMidi + cents / 100;
    if (detected < 36 || detected > 96) return false;
  }
  if (note.pitchStatus) return ["correct", "sharp", "flat"].includes(note.pitchStatus);
  return !["uncertain", "octave_uncertain", "outlier", "missed"].includes(note.status);
}

export function pitchFrequency(notes: VisualNote[]) {
  const groups = new Map<number, { midi: number; total: number; sharp: number; flat: number; excluded: number }>();
  for (const note of notes) {
    if (note.pitchMidi == null) continue;
    const row = groups.get(note.pitchMidi) ?? { midi: note.pitchMidi, total: 0, sharp: 0, flat: 0, excluded: 0 };
    if (!isScoredPitch(note)) row.excluded++;
    else {
      row.total++;
      if (note.pitchErrorCents! > PITCH_TOLERANCE_CENTS) row.sharp++;
      if (note.pitchErrorCents! < -PITCH_TOLERANCE_CENTS) row.flat++;
    }
    groups.set(note.pitchMidi, row);
  }
  return [...groups.values()].sort((a, b) => (b.sharp + b.flat) - (a.sharp + a.flat) || a.midi - b.midi);
}

function pitchColor(note: VisualNote): string {
  if (!isScoredPitch(note)) return "#9aa0a6";
  return Math.abs(note.pitchErrorCents!) > PITCH_TOLERANCE_CENTS ? "#d93025" : "#1a8737";
}

function timingColor(note: VisualNote, isFirst: boolean): string {
  if (isFirst || note.timingErrorMs == null) return "#9aa0a6";
  return Math.abs(note.timingErrorMs) > 80 ? "#d93025" : "#1a8737";
}

const W = 620;
const H = 170;
const PAD_L = 34;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 22;
const MAX_CENTS = 100;
const MAX_MS = 200;

function xFor(i: number, n: number): number {
  if (n <= 1) return PAD_L + (W - PAD_L - PAD_R) / 2;
  return PAD_L + ((W - PAD_L - PAD_R) * i) / (n - 1);
}

function yForCents(cents: number): number {
  const clamped = Math.max(-MAX_CENTS, Math.min(MAX_CENTS, cents));
  const plotH = H - PAD_T - PAD_B;
  // 偏高在上：cents 越大 y 越小
  return PAD_T + ((MAX_CENTS - clamped) / (2 * MAX_CENTS)) * plotH;
}

function yForMs(ms: number): number {
  const clamped = Math.max(-MAX_MS, Math.min(MAX_MS, ms));
  const plotH = H - PAD_T - PAD_B;
  // 抢拍在上：ms 越大 y 越小
  return PAD_T + ((MAX_MS - clamped) / (2 * MAX_MS)) * plotH;
}

/** 三遍对比：两个分并排，一眼看出有没有进步 */
export function TakeCompare({
  takes,
  selectedName,
  onSelect,
}: {
  takes: CompareTake[];
  selectedName?: string;
  onSelect?: (name: string) => void;
}) {
  const valid = takes.filter((t) => t.pitch != null || t.rhythm != null);
  if (!valid.length) return null;
  function bar(score: number | null, color: string) {
    if (score == null)
      return <span style={{ fontSize: 12, color: "var(--sf-muted)" }}>—</span>;
    return (
      <span
        style={{
          display: "inline-block",
          height: 12,
          width: `${Math.max(3, score)}%`,
          maxWidth: "100%",
          borderRadius: 6,
          background: color,
        }}
      />
    );
  }
  return (
    <div>
      <h3 style={{ fontSize: 13, margin: "14px 0 8px" }}>一遍比一遍好吗（三遍对比）</h3>
      <div style={{ display: "grid", gap: 8 }}>
        {valid.map((t) => (
          <button
            key={t.name}
            onClick={() => onSelect?.(t.name)}
            aria-pressed={selectedName === t.name}
            title={`${t.name}：音准 ${t.pitch ?? "—"}，节奏 ${t.rhythm ?? "—"}`}
            style={{
              display: "grid",
              gridTemplateColumns: "52px 1fr 34px",
              gap: 4,
              alignItems: "center",
              padding: "8px 10px",
              borderRadius: 8,
              border: selectedName === t.name ? "2px solid var(--sf-accent)" : "1px solid var(--sf-border)",
              background: "var(--sf-elevated)",
              color: "var(--sf-ink)",
              font: "inherit",
              fontSize: 12,
              cursor: onSelect ? "pointer" : "default",
              textAlign: "left",
            }}
          >
            <b>{t.name}</b>
            <span style={{ display: "grid", gap: 4 }}>
              <span style={{ display: "grid", gridTemplateColumns: "34px 1fr", gap: 6, alignItems: "center" }}>
                <span style={{ color: "var(--sf-muted)" }}>音准</span>
                {bar(t.pitch, "#1a73e8")}
              </span>
              <span style={{ display: "grid", gridTemplateColumns: "34px 1fr", gap: 6, alignItems: "center" }}>
                <span style={{ color: "var(--sf-muted)" }}>节奏</span>
                {bar(t.rhythm, "#0b8043")}
              </span>
            </span>
            <span style={{ fontWeight: 700 }}>
              {t.pitch ?? "—"} / {t.rhythm ?? "—"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function VisualReport({
  notes,
  onNoteClick,
  onMeasureClick,
  zh = true,
}: {
  notes: VisualNote[];
  onNoteClick?: (note: VisualNote) => void;
  onMeasureClick?: (measure: number) => void;
  zh?: boolean;
}) {
  if (!notes.length) return null;
  const pMid = yForCents(0);
  const pTop = yForCents(PITCH_TOLERANCE_CENTS);
  const pBot = yForCents(-PITCH_TOLERANCE_CENTS);
  const tMid = yForMs(0);
  const tTop = yForMs(80);
  const tBot = yForMs(-80);
  const measures = Array.from(new Set(notes.map((n) => n.measure))).sort((a, b) => a - b);
  const stats = new Map<number, { total: number; wrong: number; uncertain: number }>();
  for (const n of notes) {
    const s = stats.get(n.measure) ?? { total: 0, wrong: 0, uncertain: 0 };
    s.total += 1;
    if (!isScoredPitch(n)) s.uncertain += 1;
    else if (Math.abs(n.pitchErrorCents!) > PITCH_TOLERANCE_CENTS) s.wrong += 1;
    stats.set(n.measure, s);
  }

  function barColor(m: number): string {
    const s = stats.get(m);
    if (!s) return "#e8eaed";
    if (s.wrong >= 2) return "#d93025";
    if (s.wrong === 1) return "#e8710a";
    if (s.uncertain === s.total) return "#9aa0a6";
    return "#1a8737";
  }

  function barText(m: number): string {
    const s = stats.get(m);
    return zh
      ? `第 ${m} 小节：${s?.wrong ?? 0} 个音不准，${s?.uncertain ?? 0} 个未计分。点击回听本小节`
      : `Measure ${m}: ${s?.wrong ?? 0} wrong, ${s?.uncertain ?? 0} excluded. Play this measure`;
  }

  function barSub(m: number): string {
    const s = stats.get(m);
    if (!s) return "";
    if (s.wrong > 0) return zh ? `${s.wrong} 个要练` : `${s.wrong} wrong`;
    if (s.uncertain > 0) return zh ? `${s.uncertain} 未计分` : `${s.uncertain} excluded`;
    return "✓";
  }

  return (
    <div>
      <p style={{ color: "var(--sf-muted)", fontSize: 12, lineHeight: 1.6, margin: "8px 0" }}>
        {zh ? "满分 100；±15 音分（含边界）为正确，不扣音高分。空心点为异常或不确定，不计音高分。点击音符可回听。" : "Maximum score: 100. −15 to +15 cents inclusive is correct, with no pitch penalty. Hollow points are excluded as abnormal or uncertain. Click a note to listen."}
      </p>
      <h3 style={{ fontSize: 13, margin: "10px 0 8px" }}>音拉得准不准（越靠近中间线越准）</h3>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="音准图：越靠近中间线越准"
        style={{ display: "block", border: "1px solid var(--sf-border)", borderRadius: 10, background: "var(--sf-elevated)" }}
      >
        {/* 准的范围 */}
        <rect x={PAD_L} y={pTop} width={W - PAD_L - PAD_R} height={pBot - pTop} fill="#1a8737" opacity={0.12} />
        <line x1={PAD_L} y1={pMid} x2={W - PAD_R} y2={pMid} stroke="#1a8737" strokeWidth={1.5} />
        <line x1={PAD_L} y1={pTop} x2={W - PAD_R} y2={pTop} stroke="#1a8737" strokeWidth={1} strokeDasharray="5 4" opacity={0.7} />
        <line x1={PAD_L} y1={pBot} x2={W - PAD_R} y2={pBot} stroke="#1a8737" strokeWidth={1} strokeDasharray="5 4" opacity={0.7} />
        <text x={4} y={pTop + 3} fontSize={10} fill="var(--sf-muted)">偏高</text>
        <text x={4} y={pMid + 3} fontSize={10} fill="var(--sf-muted)">准</text>
        <text x={4} y={pBot + 3} fontSize={10} fill="var(--sf-muted)">偏低</text>
        {notes.map((n, i) => {
          const cx = xFor(i, notes.length);
          const uncertain = !isScoredPitch(n);
          const cy = uncertain ? pMid : yForCents(n.pitchErrorCents as number);
          return (
            <g key={n.id} onClick={() => onNoteClick?.(n)} style={{ cursor: onNoteClick ? "pointer" : "default" }}>
              <title>
                {uncertain ? (zh ? "未计分（异常/不确定）" : "Excluded (outlier/uncertain)") : `${(n.pitchErrorCents as number) > 0 ? "+" : ""}${n.pitchErrorCents} cents`} · m{n.measure}
              </title>
              {/* 加大点击热区 */}
              <circle cx={cx} cy={cy} r={11} fill="transparent" />
              <circle
                cx={cx}
                cy={cy}
                r={5.5}
                fill={uncertain ? "transparent" : pitchColor(n)}
                stroke={pitchColor(n)}
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--sf-muted)", marginTop: 6, flexWrap: "wrap" }}>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#1a8737", marginRight: 4 }} />准</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#d93025", marginRight: 4 }} />要练</span>
        <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", border: "2px solid #9aa0a6", marginRight: 4 }} />没听清</span>
      </div>

      <h3 style={{ fontSize: 13, margin: "14px 0 8px" }}>拍子卡得准不准（点在上面是抢了，在下面是拖了）</h3>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="节奏图：在上面是抢拍，在下面是拖拍"
        style={{ display: "block", border: "1px solid var(--sf-border)", borderRadius: 10, background: "var(--sf-elevated)" }}
      >
        <rect x={PAD_L} y={tTop} width={W - PAD_L - PAD_R} height={tBot - tTop} fill="#1a8737" opacity={0.12} />
        <line x1={PAD_L} y1={tMid} x2={W - PAD_R} y2={tMid} stroke="#1a8737" strokeWidth={1.5} />
        <line x1={PAD_L} y1={tTop} x2={W - PAD_R} y2={tTop} stroke="#1a8737" strokeWidth={1} strokeDasharray="5 4" opacity={0.7} />
        <line x1={PAD_L} y1={tBot} x2={W - PAD_R} y2={tBot} stroke="#1a8737" strokeWidth={1} strokeDasharray="5 4" opacity={0.7} />
        <text x={4} y={tTop + 3} fontSize={10} fill="var(--sf-muted)">抢了</text>
        <text x={4} y={tMid + 3} fontSize={10} fill="var(--sf-muted)">正好</text>
        <text x={4} y={tBot + 3} fontSize={10} fill="var(--sf-muted)">拖了</text>
        {notes.map((n, i) => {
          const cx = xFor(i, notes.length);
          const isFirst = i === 0;
          const missing = isFirst || n.timingErrorMs == null;
          const cy = missing ? tMid : yForMs(n.timingErrorMs as number);
          return (
            <g key={n.id} onClick={() => onNoteClick?.(n)} style={{ cursor: onNoteClick ? "pointer" : "default" }}>
              <title>
                {isFirst
                  ? `第一个音不计时 · 第 ${n.measure} 小节`
                  : missing
                    ? `没听清起音 · 第 ${n.measure} 小节`
                    : `${(n.timingErrorMs as number) > 0 ? "+" : ""}${n.timingErrorMs} 毫秒（${(n.timingErrorMs as number) > 0 ? "抢了" : "拖了"}） · 第 ${n.measure} 小节`}
              </title>
              <circle cx={cx} cy={cy} r={11} fill="transparent" />
              <circle
                cx={cx}
                cy={cy}
                r={5.5}
                fill={missing ? "transparent" : timingColor(n, isFirst)}
                stroke={timingColor(n, isFirst)}
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--sf-muted)", marginTop: 6, flexWrap: "wrap" }}>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#1a8737", marginRight: 4 }} />卡准了</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#d93025", marginRight: 4 }} />抢/拖太多</span>
        <span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", border: "2px solid #9aa0a6", marginRight: 4 }} />不算分</span>
      </div>

      <h3 style={{ fontSize: 13, margin: "14px 0 8px" }}>{zh ? "常错音（本遍，按错音次数排序）" : "Frequently wrong pitches (this take)"}</h3>
      <p style={{ fontSize: 12, color: "var(--sf-muted)" }}>{zh ? "仅统计可判音高；异常及不确定音不计入分母。音名包含八度。" : "Only scored pitches count toward the error rate. Outliers and uncertain notes are excluded. Names include octave."}</p>
      {pitchFrequency(notes).map((row) => {
        const name = ["C", "C♯/D♭", "D", "D♯/E♭", "E", "F", "F♯/G♭", "G", "G♯/A♭", "A", "A♯/B♭", "B"][row.midi % 12] + (Math.floor(row.midi / 12) - 1);
        const wrong = row.sharp + row.flat;
        const percent = row.total ? Math.round(wrong / row.total * 100) : 0;
        return <div key={row.midi} style={{ margin: "8px 0", fontSize: 12 }}>
          <b>{name}</b> · {wrong}/{row.total} {zh ? "次不准" : "wrong"} ({row.total ? `${percent}%` : "—"}) · ↑{row.sharp} ↓{row.flat} · {zh ? "排除" : "excluded"} {row.excluded}
          <div role="img" aria-label={`${name}: ${wrong}/${row.total}, ${percent}%`} style={{ height: 8, background: "#e8eaed", borderRadius: 4 }}><div style={{ width: `${percent}%`, height: "100%", background: "#d93025", borderRadius: 4 }} /></div>
        </div>;
      })}
      <h3 style={{ fontSize: 13, margin: "14px 0 8px" }}>{zh ? "哪段要练（点击只回听该小节）" : "Measures to practice — click to play only that measure"}</h3>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {measures.map((m) => (
          <button
            key={m}
            title={barText(m)}
            aria-label={barText(m)}
            onClick={() => onMeasureClick?.(m)}
            style={{
              minWidth: 52,
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid var(--sf-border)",
              background: barColor(m),
              color: "#fff",
              cursor: onMeasureClick ? "pointer" : "default",
            }}
          >
            <span style={{ display: "block", fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>{m}</span>
            <span style={{ display: "block", fontSize: 11, fontWeight: 600, lineHeight: 1.4, opacity: 0.95 }}>{barSub(m)}</span>
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--sf-muted)", marginTop: 6, flexWrap: "wrap" }}>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#1a8737", marginRight: 4 }} />挺好</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#e8710a", marginRight: 4 }} />1 个音不准</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#d93025", marginRight: 4 }} />要多练</span>
      </div>
    </div>
  );
}
