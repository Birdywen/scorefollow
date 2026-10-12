# 演奏分析：第一轮实现与后续路线

## 当前可运行切片

静态页面的“演奏分析”支持直接从当前 PDF 通过 halbestunde OMR 异步生成 MusicXML（或手工上传 MusicXML），以及**节拍器同步录音（最多 3 遍 take，可回听/切换/删除/单独分析）**、上传录音为一遍、指定乐器/BPM/拍号/预备拍、提交异步演奏分析任务、轮询、查看音准/节奏及按音符回听。同步录音由页面级 PracticeSession 统一时钟驱动：节拍器只本地播放、不混入录音文件，录音只采集麦克风（建议戴耳机，预备拍不计入分析），正式第一拍同時锚定谱面光标、节拍器与录音时间轴。OMR 结果**自动作为录音分析的目标谱**；MusicXML 下载仅用于备用/检查，不是继续分析的必需步骤。可指定录音从第几小节开始；超出录音时长的后续小节不计分。独立 Python 服务处理 OMR 与音频分析；**PDF 小节几何仅负责谱面显示和小节导航**，音符事件由 MusicXML 提供。只有 PDF 总小节数与 MusicXML 总小节数一致才启用小节导航；一致不保证音乐身份一致，用户仍需核对版本和反复展开顺序。录音 Blob 存 IndexedDB、元数据存 localStorage；旧的单文件上传链路仍可用（以 unsynced take 接入）。HTTP 测试页可能被浏览器禁用麦克风，此时请用上传录音流程。

当前算法是单声部、无明显伴奏、固定 BPM 的实验基线：单声道 PCM WAV、93 ms Hann 窗自相关基频、能量/音高突变起音，按 BPM 预测位置搜索 ±220 ms，取音符中后段的稳态音高。输出逐音 `pitchErrorCents`、`timingErrorMs`、`confidence`，并将音高、起音和综合状态分开；缺少足够音高帧或明确起音时分别输出 `null`，不判作正确。综合音高分使用封顶绝对 cents 误差的均值，使明确错音不能被中位数掩盖，另报正确音符的音准细节分与错音数量。跟拍分同时考虑整体抢拖拍偏移和局部波动，并另报准确度与稳定性；覆盖率低时不生成分数。首个检测起音用于校正 legacy 模式的整段起点，不计入节奏得分；即使 MusicXML 以休止小节开头，也不会凭录音前面的静音判定该休止是否拉足。分数仍是产品基线，**未经人工标注数据校准，不应作为考级/教学权威评分**。

限制：MusicXML 只支持 `score-partwise`、一个 part/voice、有 `duration` 的单音和休止、连续小节；支持 OMR 常见的十进制升降号如 `<alter>1.0</alter>`，拒绝微分音、多声部、双音、反复标记、移调记谱与隐式多乐器。谱面 tempo 标记不会覆盖面板输入的 BPM，变速、伴奏不支持。拍号仅作为 MusicXML 时值序列的一部分，BPM 以四分音符为单位。支持小提琴、中提琴、大提琴；低音提琴的移调记谱尚未校准。重复音、滑音、揉弦和擦弦起音可能低置信或误判。音准图、DTW/漏音对齐、实际谱面音符坐标尚未接入。

## 本地启动

需要 Python 3.10+ 和 NumPy：`python3 -m pip install numpy`（建议虚拟环境）。在仓库根目录给服务端设置环境变量 `HALBESTUNDE_OMR_API_KEY`，然后运行 `python3 -m analysis_service.server`，默认绑定 `127.0.0.1:8765`。不要将密钥写入仓库、Next.js 环境变量或前端。另行运行 `npm run dev`，从 `http://localhost:3000/scorefollow/` 进入“演奏分析”。可直接使用当前已载入的 PDF，或另选用于 OMR 的 PDF；识别完成后可下载 MusicXML。也可手动上传匹配的未压缩 `.musicxml`/`.xml`；再提供录音生成报告。服务接收浏览器解码转码后的 22.05 kHz 单声道 PCM WAV，不直接接受 MP3/WebM 上传到 API。

### OMR 流程与首小节整休止

OMR 适配层 `analysis_service/omr.py` 服务端完成：预签名地址 → S3 PUT（PDF）→ 提交识别（`pdf_image=true`；每任务新 `uid`/`device_hash`）→ 轮询（最长 10 分钟）→ 获取预签名下载地址 → 读取 MusicXML。密钥只随 OMR API 请求发送，S3 PUT/下载不携带密钥；前端只访问自己的分析服务。识别出的 MusicXML 若含多声部等暂不支持结构，仍可下载，但不会直接交给单声部演奏分析。

已知 OMR 缺陷是**谱面第一小节整小节休止可能导致识别失败**。仅对确认有此情形的曲目：在外部工具手工删除第一小节整休止，另存一份供 OMR 使用的 PDF；原 PDF 继续加载在 scorefollow 中。面板中另选裁好的 PDF、勾选“已删除开头整休止”、填被删除小节的四分音符拍数（例如 4/4 填 4、3/4 填 3），再开始识别。服务端会在结果 MusicXML 开头插入对应时值的整休止小节并重编小节序号，**不会自动猜测或修改原 PDF**。手工处理的谱面如小节拆分/反复顺序不同，仍需人工核对；这一补偿不代表能从录音评价开头休止的时长。

本地验证：`npm run analysis-test`（OMR 协议通过模拟服务测试，不使用真实密钥或传输真实 PDF）；完整门禁：`npm run verify`。在 HTTPS 静态网站上，分析 API 必须有单独 HTTPS 域名，面板填入该 origin；服务器的 `ANALYSIS_ALLOWED_ORIGINS` 需包含 `https://ezmusicstore.com`（注意 Origin 不含 `/scorefollow`）。`ANALYSIS_HOST`/`ANALYSIS_PORT` 可调。**静态站点部署脚本不部署分析服务**；未单独启动 HTTPS 服务时，线上只显示 UI，不会产生分析结果。

### 本机 IP 测试实例

`http://150.136.51.61/scorefollow/` 是该主机 Nginx 直接读取本仓 `out/` 的静态测试页面；`analysis_service/scorefollow-analysis.service` 安装为系统服务，密钥放在仓库外的 `/home/ubuntu/.config/scorefollow-analysis.env`（权限 600），只监听 `127.0.0.1:8765`。Nginx 的 `/scorefollow/analysis/` 代理到该回环服务，并在 `analysis_service/nginx-scorefollow-analysis.conf` 中仅允许当前测试者 IP。非 localhost 页面默认选择同源分析地址，避免浏览器误连访问者自己电脑的 `127.0.0.1`。健康检查：`http://150.136.51.61/scorefollow/analysis/health`；后续若测试者出口 IP 变化，需调整 Nginx 的访问控制。此测试环境与 ezmusicstore 的 cPanel 正式部署相互独立。

## API 契约 v0

- `POST /jobs` JSON `{scoreXml, audioWavBase64, bpm, instrument, startMeasure?, syncMode?, firstBeatAudioSec?}` → `202 {id,status}`；`startMeasure` 是从 1 开始的谱面小节编号，默认为 1；最大请求体 16 MB，音频解码后 10 MB；页面上传最长 180 秒。`legacy`（默认）按录音首个检测起音对齐此小节或其后第一个有音高的音；`metronome` 需附 `firstBeatAudioSec`（0–20 秒，足以覆盖 30 BPM 的 8 个预备拍；表示起始小节第一拍在录音中的位置），后端以它为时间轴、仅做 ±150 ms 延迟微调并返回 `syncMode/recordedFirstBeatSec/estimatedLatencyMs/coveredSec`。录音未覆盖的后续目标音符不计分。
- `GET /jobs/{id}` → `{id,status,createdAt,result?,error?}`；状态 `queued|analyzing|completed|failed`。`GET /health` 可用于检查服务。
- `POST /omr/jobs` JSON `{pdfBase64,filename,prependRestBeats?}` → `202 {id,status}`；原始 PDF ≤ 15 MB；只有另选已删除首小节的 PDF 才填写 `prependRestBeats`（整数 1–16）。`GET /omr/jobs/{id}` → `{id,status,progress?,result?,error?}`；`result` 含 `musicXml,compatible,reason,noteCount,measureCount,restoredFirstRest`。OMR 作业可能持续数分钟。
- 任务 ID 为随机不可猜字符串，任务和结果仅保留进程内最多 1 小时；进程重启即丢失。最多 4 个排队/处理中的任务。
- 本地原型服务默认仅绑定 loopback，允许 origin 需显式配置；**不能直接暴露公网**。生产化前需加鉴权/匿名限流、对象存储、持久化队列、结果数据库、过期清理、上传扫描、HTTPS 反向代理与监控。

## 下一轮验收顺序

1. **已完成第一批可信度修复**：声明音域内的高音/低音回归、93 ms 窗与周期插值、错音不能被中位数掩盖、整体抢拖拍与稳定性分开、重复音未检测到起音时不再标正确、30 BPM × 8 预备拍同步范围、节拍器启动失败丢弃录音、180 秒自动停止。
2. 建立小提琴/大提琴真实演奏标注集：音符起音、稳态 cents、滑音/揉弦、漏音、噪音；提供留出曲目验证，按乐器/速度/录音设备分层报告 precision/recall/误差。
3. 加入谱面音符时间轴的声部/连音/休止/反复标准化，识别 MusicXML 和 PDF 小节对应关系；接入 ABC 投射后才提供音符级 PDF 高亮。
4. 用稳健基频候选、谱音约束和单调序列对齐/DTW 替换简单固定时间窗；先识别漏音/多余音及整体延迟，再推出音乐性评分，明确阈值与置信度校准。
5. 将临时任务迁移到持久化异步基础设施，再提供线上服务；随后评估自由速度、伴奏分离、双音、揉弦与滑音，最后才并入综合评分。

## 开发记录（分支 analysis-opt，2026-10-01）

每条修复均先写失败测试、再改代码，全量 `npm run analysis-test` 通过后单独提交。

- **vamp-beat 起始小节以休止开头整体晚一拍**（`Fix vamp-beat grid phase…`）：网格锚在首个发声，`base_beat` 统一取首个谱面音符而非小节线。回归：`test_vamp_beat_later_measure_with_leading_rest_keeps_grid_phase`。
- **拍点单位不是四分音符**（`Reject vamp-beat grids…`）：拍点中位间隔 / 面板四分音符时长 ∉ [0.8, 1.25] 时弃用网格，退回 legacy；summary 新增 `tempoMismatch`，`detectedBpm` 照报。回归：`test_vamp_beat_grid_with_wrong_beat_unit_falls_back_to_legacy`、`test_vamp_beat_grid_near_panel_tempo_is_kept`。倍速/附点自动换算（方案 B）待真实标注集。
- **速度漂移误报错音**（`Track tempo drift…`）：legacy/metronome 搜索窗跟随已测起音线性趋势；起音单调一一匹配；趋势窗落空才回退固定网格窗，两处都落空时音高窗仍跟随趋势；计时误差仍对固定网格。实验：连奏音阶慢 5%/10% 错音 7/11 → 0。回归：`test_steady_slow_tempo_is_reported_as_late_not_wrong_pitch`，并保持 `test_timing_variation_reduces_stability`。
  - 迭代教训：只跟随趋势 → 随机抖动把中心带偏（抖动测试挂）；无条件回退 → 回退窗抓到前一音符起音、漏检时音高窗被拉回旧网格（慢速重新误报）。

已完成：

- 2026-10-12 legacy 速度趋势不再跟随错配起音 (engine.py predicted_drift / drift_obs)。压测: 快音 + 起音抖动时两音起音合并, 下一音抢走邻音起音, 该错配 (窗内测到邻音音高) 喂进趋势后搜索窗逐格后移, 偏差从 46 ms 累积到 1.2 s (Dotzauer 5 120 bpm 抖动 40 ms, 节奏分 5)。现在判 sharp/flat 或邻音归因的音不更新趋势, 斜率上限 0.25 -> 0.12 (扫 0.08/0.10/0.15: 更紧伤拖慢 12-15 百分比场景, 更松无效)。对比方案: 完全去斜率破坏稳定拖慢测试; 只吃 correct 音 (gate12) 抖动更好但抢快 8 百分比错配 24 -> 54, 弃用。Dotzauer 起音错配 (>120 ms) 改前 j40_b120 361 / fast8 24 / slow10 56, 改后 {"j40_b120": 228, "j40_b95": 8, "slow10j20": 56, "slow12j20": 52, "slow15j20": 54, "fast8j20": 23}。测试 test_drift_slip.py (八分音符琶音 180 bpm 抖动 40 ms, 最长连续错位 15 -> <=6) 修前 FAIL 修后 OK, 全量 162 tests in 6.345s OK。未决: (1) 两音起音合并后的错配本身仍在 (j40_b120 约 2 成音), 需错配自恢复; (2) 稳定偏离 8-15 百分比速度时 rhythmScore 中位数为 0 (准确度项扣光), 属评分公式产品决定, 待讨论; (3) fix2 剪头尾脱节匹配未过门槛, 补丁存 /tmp/sf_fix2_wip/, 待按残差判法重做。
- 2026-10-12 时间零点锚到首个有音高的帧 + 准点错音不按邻音错位放过 (engine.py)。e2e 压测: 前导 3% 宽带噪声过能量门限被当首音起音 (0.047 s, 实为 0.5 s), 整条时间线提前 453 ms, 此前被 `_displaced_match` 掩盖 (81/105 音判 displaced 仍得 100)。现在 onsets[0] 取首个 voiced 帧, 只回溯 <= 60 ms 连续有能量帧补音头; 起音偏差 <= max(80 ms, 25% 时值) 时不做邻音归因 (拉成邻音音高的准点错音判 wrong_pitch)。e2e: noisy 音高 [100, 100, 100, 100], wrong10pct 检出率 [1.0, 0.89, 1.0, 1.0] (修前探针 0.62-0.73), 起始小节填错 clean_m1 音高 [0, 0, 0, 0] (修前 22-58)。测试 test_noise_lead_in.py / test_displaced_on_time.py 修前 FAIL 修后 OK, 全量 160 tests in 5.109s OK。未决: 120 bpm 抖动下两音起音 <20 ms 并为一个时逐音滑格累积 (predicted_drift 跟随错配), 待修。
- 已修 自动同步小节时间随 rubato 漂移（`Follow tempo drift in the excerpt measure map`）：align_excerpt 原用单条全局直线算 measureTimes，速度起伏 3% 时小节误差可达 0.5–3 s 而残差门限（0.60 s）仍放行 confident，跟随光标一路跑偏；residualMs 无法区分对错（判对 max 119 ms，判错 p10 62 ms），故改拟合而非调门限。现改为按匹配音符的单调锚点分段插值（同拍取中位、局部 ±3 邻点直线剔除 >max(0.12 s,4×中位) 离群），首尾外推用全局斜率；engine 自动同步区间同用锚点；结果新增 `anchors` 字段，旧字段不变。证据（真实 Dotzauer 5 谱合成压力，每场景 30 次）：rubato_.03 误判 3→0、小节最大误差 p90 0.606→0.028 s；rubato_.08 误判 10→0、小节最大误差 p90 1.111→0.028 s；realistic 误判 5→0、小节最大误差 p90 0.532→0.079 s；hard 误判 10→3、小节最大误差 p90 0.592→0.296 s；clean 中位误差 0.001→0.007 s（锚点含 10 ms 抖动，可接受）；unrelated 30/30 拒绝不变。回归：`test_alignment_rubato.py`（修复前最大小节误差 0.475 s）。
- 已修 #9（`Use a capped mean for timing accuracy`）：timingAccuracyScore 由中位数改为截断均值（单音 ≤250 ms）。证据：准确度（稳定/单音+400 ms/抖动）97/95/51 → 96/70/51。回归：`test_one_badly_timed_note_lowers_accuracy`。XML 重复解析（parse_score/measure_start_beats/seconds_per_quarter/measureCount）在 300 s 上限下耗时可忽略，不改。
- 结论 #10（不改）：`notes[].measure` 用小节序号而非 `number` 属性是有意的——前端 `onJump(note.measure)` 按 PDF 小节序号跳转，`canJump` 要求 `pdfMeasures === measureCount`；弱起谱改用 `number`（=0）会让 PDF 跳转差一。若要显示印刷小节号，应另加 `measureLabel` 字段。
- 已做 #8（`Batch track() FFTs in chunks`）：track() 分块批量 rfft/irfft（`TRACK_CHUNK_FRAMES=128`），峰值挑选逻辑不变。证据：track 耗时 60s/22k 1.12s→0.56s；60s/48k 2.02s→1.07s；300s/22k 5.60s→2.78s；300s/48k 10.19s→5.41s；与逐帧版 7 类信号对比 times/energy 逐位一致、NaN 模式与门限零翻转、音高最大差 0.0036 音分（浮点舍入）。locate_excerpt DTW（400 音符×64 事件 0.48 s）不改。
- 已修 #7（`Validate pitch hints on every path and stop filling gaps`）：指定小节路径也走 `usable_events` 校验（乱序/重叠报错）；`_hint_track` 只在 pYIN 段内部补盲区，段间静音留 NaN。实验：漏奏第 3 音 + pYIN 提示（legacy）修复前判 +200 音分错音、音高分 99→75。回归：`test_missing_note_with_pyin_hint_is_uncertain_not_wrong_pitch`、`test_unsorted_pitch_hint_is_rejected_without_auto_location`。
- 已修 #6（`Normalize recording level before analysis`）：analyze 先在原始电平判定削波，再把峰值归一化到 `NORMALIZED_PEAK=0.5`，绝对能量阈值与录音电平无关；read_wav（钢琴/Vamp 复用）不变。实验：峰值 0.012 修复前报"无法检测到演奏"，0.02~0.32 节奏分 89/93/96/90 漂移。回归：`test_quiet_recording_is_analyzed_like_a_normal_one`。
- 已修 #5（`Score large timing errors instead of dropping them`）：常规窗（±min(0.22 s, 35%)）落空时启用宽窗，每侧 ≤ 相邻音符时长 45%、≤0.4 s，起音单调一一匹配，命中后音高窗锚到实测起音。回归：`test_large_timing_errors_are_scored_not_dropped`（±300 ms 修复前 timed=1 不出分）。
  - 迭代教训：宽窗命中最初也喂给漂移趋势，两个 +300 ms 离群点让线性外推冲到 +500 ms，第 3 音抓到第 4 音起音（误报错音）；改为只有常规窗命中才进入趋势观测。
  - 迭代教训：前音拖、后音抢时前音被挤到 0.4 s，固定 78% 时长的音高窗采到后一音（+198 音分误报错音）；音高窗改为不越过下一个实测起音（仅本音起音已测到时截断）。
- 已修 #11（`Detect semitone legato onsets…`）：半音过渡 2 帧差仅 ~0.78 半音（阈值 0.85），补"前后段各自平稳、中位数差 ≥0.6 半音"阶跃判据。回归：`test_semitone_legato_onsets_are_detected`；揉弦对照（±30 音分 5.5 Hz 持续音）可判起音数不增加。风险：宽幅慢揉弦（>±30 音分）未经真实录音验证。
- 已定（产品决定）：稳定地慢只扣 `timingAccuracyScore`；`rhythmStabilityScore` 对去除线性速度趋势后的残差计算（≥6 个起音才去趋势）。回归：`test_steady_slow_tempo_costs_accuracy_not_stability`。
- 已实现：`tempoMismatch` 在报告摘要区（PerformancePanel 结果区，startMeasure 行之前）显示检测 BPM；录音面板不显示（产品决定）。
- 2026-10-12 刚性网格补救：自动对齐小节 + 八度/速度自适应（engine.py `_auto_measure_sync`，版本 string-mono-0.4）。legacy 指定小节路径在刚性网格解释失败（出不了分或过低）时，用内置跟踪分段做音高证据重对齐：(0,-12,+12) 移调搜索 + align_excerpt（不移调优先，移调候选须明显更优才胜出），可用时按分段锚点生成 markers 并递归走 manual-measures 重算（只定小节边界，小节内照常评分）。原因进 `rescueReasons`（octave/tempo/pause/offset/range）+ limitations 中文说明；全败时 `syncAdvice` 给出可操作建议，绝不静默零分。速度带 [0.8, 1.25] 与拍点粗筛同带：带内慢 5–10% 照实报 late，带外才重对齐；拖慢/抖动/噪声/离群测试因原因全空不受影响。另：无 pYIN 的自动定位退回内置分段（原来直接报错），事件不足 8 个才保留原报错。实案：Lully Gavotte（谱面高八度 + 面板 80 实测 ~132 + 中途 1.4 s 停顿 + 40 s 额外练习）修复前音准 null/节奏 0，修复后 95/87。回归：`test_auto_rescue.py`（7 项）+ `test_without_pitch_sensor…` 按新语义更新；全量 170 tests OK。

未决：

- 音符时长在 vamp-beat+指定小节时仍按面板 BPM（±25% 内无可复现失败，随方案 B 处理）。


## 2026-10-12 录音比谱面长：保留锚定前缀，不再整段放弃

**现象**：Suzuki Vol. III（Lully Gavotte）一页谱（40 小节）+ 116 s 完整演奏，线上显示音准未计分/0、节奏 53。

**根因**：
- OMR 把低音谱号识别为 `clef-octave-change=1`，谱面整体高八度；补救的 -12 候选本已正确对上（cost 0.589，190/213 匹配）。
- 谱面只覆盖演奏前约 70 s；尾部匹配被 DTW 拉到 102–105 s，与局部锚点线偏离约 29 s，`boundarySupported=false`（4e798a9 的门禁，拒绝本身正确）。
- 拒绝后整段放弃，退回高八度 + 面板 80 BPM 刚性网格，得到无意义的 null/53。

**修法**（fix/take-beyond-score）：
- `align_excerpt`：匹配 ≥16 时，从尾部剔除偏离锚点线 >0.60 s 的配对，剩余须 ≥ max(8, 50%) 且首配对在线上；首尾门禁照常在新端点上运行，不放宽阈值，不做全局外推。输出 `tailTrimmedAfterSec`。
- 引擎：summary 新增 `takeBeyondScoreAfterSec`，limitations 写明“录音在 Xs 之后还有约 Ys 内容与谱面对不上……谱面可能缺页”。
- `quality.issues` 新增 `take_beyond_score`，outcome 保持 `partial`（不宣称全段已评）。
- 前端：质量卡片与报告警告显示截尾时间；analysis-guard 接受该字段（数值或 null）。

**验证**：全量 187 tests OK（skipped=3）；Suzuki 真实回放（内置检测 + vamp-beat）pitch 96 / rhythm 88，shift -12，m.1–37，tail_after 73.6 s；线上口径（vamp + legacy，bpm 80）pitch 95 / rhythm 82，实测 129.2 BPM。小提琴/大提琴、面板 80/126 BPM 结果一致。

**测试调整**：`test_rejected_tail_cannot_have_a_confident_projected_boundary` 改为“尾部偏离被截掉、不外推”；新增短片段（12 音）守门测试，保持整体拒绝。`test_suzuki_real` 由“失败并提示检查谱面”改为“前缀高分 + take_beyond_score”。

**已知缺口（未修）**：
- 刚性网格得到“还行但明显不对”的分数（如 79/56）时 `_needs_rescue_check` 不触发，而补救可得 95/82；门槛需重新校准。
- 前端乐器默认 `violin`，大提琴谱不会自动切换；应按谱号/音域推断或提示。
- 补救失败时 shift 0/+12 的真实 ValueError 被 `boundary_failure` 文案覆盖，诊断信息不完整。


## 2026-10-12 降级提示误报：legacy/手动小节下的 beat:legacy

- 现象：Suzuki 回放音高/起音均为完整 vamp（fused-pitch、qm-onset），页面仍显示“降级算法：节拍”，quality.issues 含 builtin_detectors。
- 根因：engine 只在 vamp-beat 下使用拍点网格（_effective_beat），legacy/manual-measures 下传 None，degradation_reasons 把“未请求的拍点网格”算成回退。
- 修法：degradation_reasons 增加 beat_requested（默认 True，旧调用不变）；engine 传 sync_mode == "vamp-beat"。音高/起音判定不变。
- 验证：test_degraded_beat.py（先失败后通过）、全量 unittest、Suzuki bpm80 violin 经 server.run 回放 degraded=false。
- 补充：beat_requested 取 analyze 入口时的请求模式（_beat_req），不取引擎内部 vamp-beat→legacy 回退后（engine.py 回退点）或补救重算（manual-measures）的模式；补救重算经私有参数 _beat_requested 继承。否则“请求了拍点跟踪但网格不可用”这一真实降级会被藏掉。新增 RequestedBeatFallbackTests 覆盖。两条旧测试（test_golden_scoring / test_vamp_degraded，均为 legacy 请求）断言改为不报 beat:legacy，vamp 缺失仍报 pitch/onset 降级。


## 2026-10-12 拍点网格被否决 ≠ 插件不可用（beat:rejected）

- 现象：06ae511 后 Suzuki 经 HTTP（服务端默认 syncMode=vamp-beat）仍报 beat:legacy，页面提示“完整 vamp 插件不可用”；实际 QM 给出 253 拍（129.2 BPM）。
- 根因：_select_grid_scale 用音高证据投票（±1.5 半音命中率 ≥0.6），谱面整体高八度时命中为 0，网格被否决、回退 legacy；判定正确，但被当成插件缺失。
- 修法：否决时记 _beat_rejected（经私有参数 _beat_rejected_in 传入补救重算），degradation_reasons 输出 beat:rejected；quality 仅此一项时报 beat_grid_rejected 而非 builtin_detectors；前端标签“节拍网格未采用”并改悬停说明。旧报告（无 degradedReasons）行为不变。
- 验证：GridRejectedTests（先失败后通过）、全量 unittest、tsc、analysis-guard、Suzuki bpm80 violin vamp-beat/legacy 回放。
