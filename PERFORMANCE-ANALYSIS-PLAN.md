# 演奏分析：第一轮实现与后续路线

## 当前可运行切片

静态页面的“演奏分析”支持直接从当前 PDF 通过 halbestunde OMR 异步生成 MusicXML（或手工上传 MusicXML），以及**节拍器同步录音（最多 3 遍 take，可回听/切换/删除/单独分析）**、上传录音为一遍、指定乐器/BPM/拍号/预备拍、提交异步演奏分析任务、轮询、查看音准/节奏及按音符回听。同步录音由页面级 PracticeSession 统一时钟驱动：节拍器只本地播放、不混入录音文件，录音只采集麦克风（建议戴耳机，预备拍不计入分析），正式第一拍同時锚定谱面光标、节拍器与录音时间轴。OMR 结果**自动作为录音分析的目标谱**；MusicXML 下载仅用于备用/检查，不是继续分析的必需步骤。可指定录音从第几小节开始；超出录音时长的后续小节不计分。独立 Python 服务处理 OMR 与音频分析；**PDF 小节几何仅负责谱面显示和小节导航**，音符事件由 MusicXML 提供。只有 PDF 总小节数与 MusicXML 总小节数一致才启用小节导航；一致不保证音乐身份一致，用户仍需核对版本和反复展开顺序。录音 Blob 存 IndexedDB、元数据存 localStorage；旧的单文件上传链路仍可用（以 unsynced take 接入）。HTTP 测试页可能被浏览器禁用麦克风，此时请用上传录音流程。

当前算法是单声部、无明显伴奏、固定 BPM 的实验基线：单声道 PCM WAV、Hann 窗自相关基频、能量/音高突变起音，按 BPM 预测位置搜索 ±220 ms，取音符中后段的稳态音高。输出逐音 `pitchErrorCents`、`timingErrorMs`、`confidence`；缺少足够音高帧或明确起音时分别输出 `null`，不判作正确。音准分是音符绝对 cents 偏差中位数的线性映射；节奏分是相对起音误差中位数的 MAD 线性映射；覆盖率低时不生成分数。首个有音高的音用于校正整段起点，不计入节奏得分；即使 MusicXML 以休止小节开头，也不会凭录音前面的静音判定该休止是否拉足。分数是产品基线，**未经人工标注数据校准，不应作为考级/教学权威评分**。

限制：MusicXML 只支持 `score-partwise`、一个 part/voice、有 `duration` 的单音和休止、连续小节；支持 OMR 常见的十进制升降号如 `<alter>1.0</alter>`，拒绝微分音、多声部、双音、反复标记、移调记谱与隐式多乐器。谱面 tempo 标记不会覆盖面板输入的 BPM，变速、伴奏不支持。拍号仅作为 MusicXML 时值序列的一部分，BPM 以四分音符为单位。支持小提琴、中提琴、大提琴；低音提琴的移调记谱尚未校准。重复音、滑音、揉弦和擦弦起音可能低置信或误判。音准图、DTW/漏音对齐、实际谱面音符坐标尚未接入。

## 本地启动

需要 Python 3.10+ 和 NumPy：`python3 -m pip install numpy`（建议虚拟环境）。在仓库根目录给服务端设置环境变量 `HALBESTUNDE_OMR_API_KEY`，然后运行 `python3 -m analysis_service.server`，默认绑定 `127.0.0.1:8765`。不要将密钥写入仓库、Next.js 环境变量或前端。另行运行 `npm run dev`，从 `http://localhost:3000/scorefollow/` 进入“演奏分析”。可直接使用当前已载入的 PDF，或另选用于 OMR 的 PDF；识别完成后可下载 MusicXML。也可手动上传匹配的未压缩 `.musicxml`/`.xml`；再提供录音生成报告。服务接收浏览器解码转码后的 22.05 kHz 单声道 PCM WAV，不直接接受 MP3/WebM 上传到 API。

### OMR 流程与首小节整休止

OMR 适配层 `analysis_service/omr.py` 服务端完成：预签名地址 → S3 PUT（PDF）→ 提交识别（`pdf_image=true`；每任务新 `uid`/`device_hash`）→ 轮询（最长 10 分钟）→ 获取预签名下载地址 → 读取 MusicXML。密钥只随 OMR API 请求发送，S3 PUT/下载不携带密钥；前端只访问自己的分析服务。识别出的 MusicXML 若含多声部等暂不支持结构，仍可下载，但不会直接交给单声部演奏分析。

已知 OMR 缺陷是**谱面第一小节整小节休止可能导致识别失败**。仅对确认有此情形的曲目：在外部工具手工删除第一小节整休止，另存一份供 OMR 使用的 PDF；原 PDF 继续加载在 scorefollow 中。面板中另选裁好的 PDF、勾选“已删除开头整休止”、填被删除小节的四分音符拍数（例如 4/4 填 4、3/4 填 3），再开始识别。服务端会在结果 MusicXML 开头插入对应时值的整休止小节并重编小节序号，**不会自动猜测或修改原 PDF**。手工处理的谱面如小节拆分/反复顺序不同，仍需人工核对；这一补偿不代表能从录音评价开头休止的时长。

本地验证：`python3 -m unittest discover -s analysis_service -t .`（OMR 协议通过模拟服务测试，不使用真实密钥或传输真实 PDF）；Web 前端：`npm run verify`。在 HTTPS 静态网站上，分析 API 必须有单独 HTTPS 域名，面板填入该 origin；服务器的 `ANALYSIS_ALLOWED_ORIGINS` 需包含 `https://ezmusicstore.com`（注意 Origin 不含 `/scorefollow`）。`ANALYSIS_HOST`/`ANALYSIS_PORT` 可调。**静态站点部署脚本不部署分析服务**；未单独启动 HTTPS 服务时，线上只显示 UI，不会产生分析结果。

### 本机 IP 测试实例

`http://150.136.51.61/scorefollow/` 是该主机 Nginx 直接读取本仓 `out/` 的静态测试页面；`analysis_service/scorefollow-analysis.service` 安装为系统服务，密钥放在仓库外的 `/home/ubuntu/.config/scorefollow-analysis.env`（权限 600），只监听 `127.0.0.1:8765`。Nginx 的 `/scorefollow/analysis/` 代理到该回环服务，并在 `analysis_service/nginx-scorefollow-analysis.conf` 中仅允许当前测试者 IP。非 localhost 页面默认选择同源分析地址，避免浏览器误连访问者自己电脑的 `127.0.0.1`。健康检查：`http://150.136.51.61/scorefollow/analysis/health`；后续若测试者出口 IP 变化，需调整 Nginx 的访问控制。此测试环境与 ezmusicstore 的 cPanel 正式部署相互独立。

## API 契约 v0

- `POST /jobs` JSON `{scoreXml, audioWavBase64, bpm, instrument, startMeasure?, syncMode?, firstBeatAudioSec?}` → `202 {id,status}`；`startMeasure` 是从 1 开始的谱面小节编号，默认为 1；最大请求 8 MB，音频 5 MB/90 秒。`legacy`（默认）按录音首个有音高的音对齐此小节或其后第一个有音高的音；`metronome` 需附 `firstBeatAudioSec`（0–10 秒，起始小节第一拍在录音中的位置），后端以它为时间轴、仅做 ±150 ms 延迟微调并返回 `syncMode/recordedFirstBeatSec/estimatedLatencyMs/coveredSec`。录音未覆盖的后续目标音符不计分。
- `GET /jobs/{id}` → `{id,status,createdAt,result?,error?}`；状态 `queued|analyzing|completed|failed`。`GET /health` 可用于检查服务。
- `POST /omr/jobs` JSON `{pdfBase64,filename,prependRestBeats?}` → `202 {id,status}`；原始 PDF ≤ 15 MB；只有另选已删除首小节的 PDF 才填写 `prependRestBeats`（整数 1–16）。`GET /omr/jobs/{id}` → `{id,status,progress?,result?,error?}`；`result` 含 `musicXml,compatible,reason,noteCount,measureCount,restoredFirstRest`。OMR 作业可能持续数分钟。
- 任务 ID 为随机不可猜字符串，任务和结果仅保留进程内最多 1 小时；进程重启即丢失。最多 4 个排队/处理中的任务。
- 本地原型服务默认仅绑定 loopback，允许 origin 需显式配置；**不能直接暴露公网**。生产化前需加鉴权/匿名限流、对象存储、持久化队列、结果数据库、过期清理、上传扫描、HTTPS 反向代理与监控。

## 下一轮验收顺序

1. 建立小提琴/大提琴真实演奏标注集：音符起音、稳态 cents、滑音/揉弦、漏音、噪音；提供留出曲目验证，按乐器/速度/录音设备分层报告 precision/recall/误差。
2. 加入谱面音符时间轴的声部/连音/休止/反复标准化，识别 MusicXML 和 PDF 小节对应关系；接入 ABC 投射后才提供音符级 PDF 高亮。
3. 用稳健基频候选、谱音约束和单调序列对齐/DTW 替换简单固定时间窗；先识别漏音/多余音及整体延迟，再推出音乐性评分，明确阈值与置信度校准。
4. 将临时任务迁移到持久化异步基础设施，再提供线上服务；随后评估自由速度、伴奏分离、双音、揉弦与滑音，最后才并入综合评分。
