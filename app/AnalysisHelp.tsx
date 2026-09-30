import styles from "./page.module.css";

const topics = [
  {
    title: ["1 · 准备谱面和录音", "1 · Prepare the score and audio"],
    text: [
      "先打开“演奏分析”，上传 MusicXML（不超过 1 MB），或把 PDF 识别为 MusicXML（PDF 不超过 15 MB）。PDF 上能看到小节线，不代表已经识别出音符。请核对调号、升降号、休止符和小节数，再选择乐器。当前谱面解析只接受单声部、实音、顺序谱；和弦、多声部、移调记谱与中途变拍暂不支持，反复和跳房子须先展开。钢琴也受这个谱面限制。",
      "Open Analyze and upload MusicXML (up to 1 MB), or recognize a PDF into MusicXML (PDF up to 15 MB). Detecting bar lines on a PDF does not recognize its notes. Check keys, accidentals, rests and measure counts, then choose the instrument. The current score parser requires a single voice, concert pitch and a linear score. Chords, multiple voices, transposing notation and meter changes are unsupported; expand repeats and endings first. These score restrictions also apply to piano.",
    ],
  },
  {
    title: ["2 · 录音、上传与保存", "2 · Record, upload and store takes"],
    text: [
      "可用麦克风录音，也可上传浏览器能解码的 WAV、MP3、M4A、WebM 等音频；能否解码取决于浏览器。页面分析接受 0.4–90 秒、原文件不超过 40 MB，发送前会转换成单声道 WAV。录音接近 90 秒时自动停止。保持独奏、避免伴奏串音和过载；同步录音建议戴耳机，减少节拍器漏入麦克风。录音和上传共用 3 个位置，满额后新增会替换当前选中项（未选中则替换第一项）。录音尝试保存在本机浏览器中，存储失败时仅在本次页面保留，不是云端备份。分析时音频和 MusicXML 会发送到所配置的服务，钢琴音频还会转交转录服务。",
      "Record with a microphone or upload audio your browser can decode, such as WAV, MP3, M4A or WebM; codec support varies. This page accepts 0.4–90 seconds and original files up to 40 MB, converting them to mono WAV before analysis. Recording stops near 90 seconds. Use a clear solo recording without accompaniment or clipping; headphones reduce metronome bleed during synced recording. Recordings and uploads share three slots. Adding a take when full replaces the selected take, or the first if none is selected. Takes are saved locally when browser storage is available, otherwise only for this page session—not as a cloud backup. Analysis sends audio and MusicXML to the configured service; piano audio is also sent to its transcription service.",
    ],
  },
  {
    title: ["3 · 普通分析还是自动定位？", "3 · Analyze or Find excerpt?"],
    text: [
      "知道起点时，添加录音前设置起始小节和 BPM，再点“分析这一遍”；这些参数保存在每一遍录音上。起点未知的未同步弦乐录音可点“自动定位片段”，系统综合音高序列与可用的独立拍点寻找起始音符。重复乐句、可靠音符太少或长短窗口结论不一致时会拒绝定位：请选择更有辨识度的片段，或手动指定起始小节。定位只找开头，不会在中途跳小节、重弹后持续重新定位；钢琴和带节拍器同步标记的录音不能使用此按钮。",
      "If you know the start, set the start measure and BPM before adding a take, then choose Analyze; each take stores these settings. For an unsynced string recording with an unknown start, use Find excerpt. It matches the pitch sequence and available independent beat times to a starting note. Repeated phrases, too few reliable events or disagreement between short and long windows can prevent localization: choose a more distinctive passage or specify the start measure manually. Localization finds the opening only; it does not recover from later jumps or restarts. Piano and metronome-synced takes cannot use this button.",
    ],
  },
  {
    title: ["4 · BPM 与时间基准", "4 · BPM and timing reference"],
    text: [
      "未同步弦乐录音优先使用自动检测的拍点；拍点不可用时退回该遍录音保存的 BPM，所以仍需填合理速度。弦乐的 6/8、9/8、12/8 按附点四分音符一拍解释 BPM，其他支持拍号按四分音符。同步录音以节拍器第一拍为基准，允许小幅延迟修正。钢琴当前使用固定四分音符 BPM，不自动跟随速度；复合拍号不要直接套用弦乐的 BPM 单位。",
      "Unsynced strings prefer detected beats and fall back to the take’s saved BPM when beat tracking is unavailable, so enter a reasonable tempo. For strings, 6/8, 9/8 and 12/8 use dotted-quarter BPM; other supported meters use quarter-note BPM. Synced recordings use the metronome’s first beat with a small latency adjustment. Piano currently uses fixed quarter-note BPM without automatic tempo tracking; do not reuse the string BPM convention for compound meters.",
    ],
  },
  {
    title: ["5 · 如何读弦乐分数", "5 · Read string scores"],
    text: [
      "综合音高分根据可判音符的音分偏差计算，不是“弹对百分比”；100 音分等于一个半音，正值偏高、负值偏低，超过 ±50 音分记为错音。正确音音准只看已判正确的音。跟拍同时考虑整体抢拍/拖拍和局部波动；稳定性高不代表没有整体偏移。首音用于锚定，不计入弦乐节奏分。没听清与八度不确定不算正确，也不直接按错音扣分；“—”表示没有足够依据评分，不是零分。请一起看可判音符、可判起音和覆盖范围，不要只比较总分。",
      "Pitch is based on cents errors in judgeable notes, not a percentage of correct notes. One semitone is 100 cents; positive is sharp and negative is flat. Errors beyond ±50 cents are wrong pitches. Intonation measures only notes already classified as correct. Timing combines overall rushing/dragging and local variation; high stability does not guarantee accurate timing. The first note is an anchor and is excluded from string rhythm scoring. Unclear and octave-uncertain notes are neither confirmed correct nor directly penalized as wrong pitches. A dash means insufficient evidence, not zero. Read coverage and judgeable-note/onset counts alongside the scores.",
    ],
  },
  {
    title: ["6 · 钢琴目前的限制", "6 · Current piano limitations"],
    text: [
      "钢琴依赖独立音符转录服务，使用与弦乐不同的音符匹配分（F1）：200 × 正确匹配数 ÷（覆盖范围内谱面音符数 + 演奏音符数），漏音和多音都会降低分数，错音可能体现为一个漏音加一个多音。新版按 WAV 文件实际结束时间裁去后续谱面音符；录音仍在继续时的静音不会被裁掉，其中应弹未弹的音仍计漏音。首音作为时间锚不计入节奏分。钢琴尚不支持自动片段定位或任意多声部谱，分数依赖转录质量，不是连续音分音准测量，不能与弦乐直接比较。旧版报告仍可能使用未计漏音、多音的旧评分，请重新分析并确认服务版本。",
      "Piano uses a separate transcription service and a note-matching F1 score: 200 × correct matches ÷ (score notes in the covered passage + performed notes). Missed and extra notes both reduce it; a wrong pitch may appear as one miss plus one extra. The new version trims later score notes at the actual WAV end. Silence while recording continues is retained, so missing notes during that silence still count. The first note anchors timing and is excluded from rhythm scoring. Piano still lacks automatic excerpt location and general multi-voice score support. Scores depend on transcription quality, do not measure continuous cents-level intonation and cannot be compared directly with strings. Older reports may still use the previous score without missed/extra penalties; reanalyze and check the service version.",
    ],
  },
  {
    title: ["7 · 回听、空分数与常见故障", "7 · Replay, missing scores and troubleshooting"],
    text: [
      "点击报告音符或“复习片段”可从音符前约 0.5 秒回听；小节数核对一致后再映射到 PDF。“模拟效果图”是示例，不是你的演奏结果。分数为空时先看可判比例，检查录音是否太短、过轻、失真或混入伴奏，再核对谱面版本和起始小节。若提示 HTML、403、网络错误或钢琴转录失败，检查分析服务地址、访问权限及服务状态；这不代表演奏有问题。HTTPS 页面必须连接 HTTPS 分析服务。分数用于帮助练习回听，尚不是经过人工标注校准的考试评分。",
      "Click a report note or review moment to replay from about 0.5 seconds before it. Verify measure counts before mapping to the PDF. Sample charts are demonstrations, not your results. For missing scores, check coverage, recording length, low level, distortion or accompaniment, then confirm the score version and start measure. HTML, 403, network errors or piano transcription failures call for checking the API address, access rules and service status—not your playing. HTTPS pages require an HTTPS analysis service. Scores guide practice and listening; they are not human-calibrated examination grades.",
    ],
  },
];

export default function AnalysisHelp({ lang }: { lang: "zh" | "en" }) {
  const index = lang === "zh" ? 0 : 1;
  return <section className={styles.analysisHelp} aria-labelledby="analysis-help-title">
    <h3 id="analysis-help-title">{index === 0 ? "演奏分析 · 操作与报告指南" : "Performance analysis · workflow and reports"}</h3>
    <p>{index === 0 ? "准备 MusicXML → 添加录音 → 分析或定位 → 核对覆盖范围 → 回听问题音符。展开下方条目查看详情。" : "Prepare MusicXML → add a take → analyze or locate → check coverage → replay notes. Expand a topic for details."}</p>
    {topics.map((topic) => <details key={topic.title[1]}>
      <summary>{topic.title[index]}</summary>
      <p>{topic.text[index]}</p>
    </details>)}
  </section>;
}
