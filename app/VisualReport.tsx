"use client";

export type VisualNote = {
  id: string;
  measure: number;
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
    status: c == null ? "uncertain" : Math.abs(c) > 50 ? "wrong_pitch" : "correct",
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

function pitchColor(note: VisualNote): string {
  if (note.pitchErrorCents == null) return "#9aa0a6";
  return Math.abs(note.pitchErrorCents) > 50 ? "#d93025" : "#1a8737";
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
}: {
  notes: VisualNote[];
  onNoteClick?: (note: VisualNote) => void;
  onMeasureClick?: (measure: number) => void;
}) {
  if (!notes.length) return null;
  const pMid = yForCents(0);
  const pTop = yForCents(50);
  const pBot = yForCents(-50);
  const tMid = yForMs(0);
  const tTop = yForMs(80);
  const tBot = yForMs(-80);
  const measures = Array.from(new Set(notes.map((n) => n.measure))).sort((a, b) => a - b);
  const stats = new Map<number, { total: number; wrong: number; uncertain: number }>();
  for (const n of notes) {
    const s = stats.get(n.measure) ?? { total: 0, wrong: 0, uncertain: 0 };
    s.total += 1;
    if (n.pitchErrorCents == null) s.uncertain += 1;
    else if (Math.abs(n.pitchErrorCents) > 50) s.wrong += 1;
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
    if (!s) return `第 ${m} 小节`;
    if (s.wrong > 0) return `第 ${m} 小节：${s.wrong} 个音不准，点我跳到谱子`;
    if (s.uncertain === s.total) return `第 ${m} 小节：没听清，不算分`;
    return `第 ${m} 小节：都挺准，点我跳到谱子`;
  }

  function barSub(m: number): string {
    const s = stats.get(m);
    if (!s) return "";
    if (s.wrong > 0) return `${s.wrong} 个要练`;
    if (s.uncertain === s.total) return "没听清";
    return "✓";
  }

  return (
    <div>
      <p style={{ color: "var(--sf-muted)", fontSize: 12, lineHeight: 1.6, margin: "8px 0" }}>
        点越靠近中间绿线越好；红点是要练的；空心点是没听清、不算分。点任意点可以直接回听。
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
          const uncertain = n.pitchErrorCents == null;
          const cy = uncertain ? pMid : yForCents(n.pitchErrorCents as number);
          return (
            <g key={n.id} onClick={() => onNoteClick?.(n)} style={{ cursor: onNoteClick ? "pointer" : "default" }}>
              <title>
                {uncertain ? "没听清" : `${(n.pitchErrorCents as number) > 0 ? "+" : ""}${n.pitchErrorCents} 音分`} · 第 {n.measure} 小节
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

      <h3 style={{ fontSize: 13, margin: "14px 0 8px" }}>哪段要练（数字是这小节几个音要练）</h3>
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
