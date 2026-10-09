# Vamp 插件耳朵：构建配方（Oracle ARM 实测通过，2026-09-28）

分析服务默认只依赖 numpy。装好本页插件后，`analysis_service/server.py`
会在每次 `/jobs` 分析时自动试用 pYIN（基频）+ QM（起音）；缺插件时引擎
静默退回自研检测，前端零改动。结果 `summary.sensors` 标明本次用的耳朵：
`["pyin-pitch", "qm-onset"]` 或 `["builtin"]`。

## 1. 系统包

```bash
sudo apt-get install -y vamp-plugin-sdk g++ libboost-dev
pip3 install --user vamp   # Python 桥（注意：不是已死的 Vampy）
```

### 1b. 无 sudo 变体（rootless，经 Ubuntu 24.04 x86_64 实测通过，2026-10-10）

无 root 时用 `apt-get download` + `dpkg-deb -x` 把头文件和运行库 stage 到
`/tmp`，编译时加 `-I/-L` 指向它们，链接时 baked 绝对 rpath 指向 `~/.vamp`，
全程不写 `/etc`、不用 sudo（构建日志见 `/tmp/vamp-build.log`，不提交）：

```bash
pip3 install --user setuptools                       # 先装：本机 managed python 缺 setuptools
pip3 install --user --no-build-isolation vamp       # vamp 1.1.0 sdist 的 setup.py 在
                                                    # build-isolation 下 import numpy 失败，关掉隔离即可（numpy 2.5.3 已就绪）
mkdir -p /tmp/vamp-sdk-root /tmp/boost-root
cd /tmp && apt-get download vamp-plugin-sdk libvamp-sdk2v5 libvamp-hostsdk3v5 \
  && apt-get download libboost1.83-dev
for f in vamp-plugin-sdk_*.deb libvamp-sdk2v5_*.deb libvamp-hostsdk3v5_*.deb; do
  dpkg-deb -x "$f" /tmp/vamp-sdk-root
done
dpkg-deb -x libboost1.83-dev_*.deb /tmp/boost-root
```

第 2–3 节的 make 调用各追加
`-I/tmp/vamp-sdk-root/usr/include -I/tmp/boost-root/usr/include`，
`PLUGIN_LDFLAGS/LDFLAGS` 追加 `-L/tmp/vamp-sdk-root/usr/lib/x86_64-linux-gnu`
和 `-Wl,-rpath,/home/user/.vamp`（注意：`$ORIGIN` 会被 make/sh 两轮展开吃掉，
用绝对 rpath），然后把 `libvamp-sdk.so.2.10.0`（+ `libvamp-sdk.so.2` 软链）
与两个插件 `.so` 一起拷进 `~/.vamp/` 即可，运行时无需 `LD_LIBRARY_PATH`。

## 2. pYIN（基频+音符跟踪）

```bash
git clone --depth 1 https://github.com/c4dm/pyin.git /tmp/pyin && cd /tmp/pyin
make -f Makefile.linux64 pyin.so \
  CFLAGS="-Wall -O3 -fPIC" \
  PLUGIN_LDFLAGS="-shared -lvamp-sdk -Wl,--version-script=vamp-plugin.map"
mkdir -p ~/.vamp && cp pyin.so ~/.vamp/
```

要点：默认构建找 `../vamp-plugin-sdk` 源码树和 x86 flag，本机用 apt 版
SDK（头文件在系统路径）+ 上面这组覆盖参数直编即可。

## 3. QM 插件全家桶（起音/节拍/色度/调性/转录）

qm-dsp 与插件本体的上游 Makefile 都带 x86 `-msse`，且命令行覆盖
CFLAGS 会吞掉文件里的 `-I.` 追加——配方如下（`qm/` 与 `qm-dsp/` 为
同级目录，`qm-vamp-plugins` 与 `qm-dsp` 两个仓库）：

```bash
git clone --depth 1 https://github.com/c4dm/qm-vamp-plugins.git qm
git clone --depth 1 https://github.com/c4dm/qm-dsp.git qm-dsp

DSPFLAGS="-DNDEBUG -Wall -Wextra -O3 -fPIC -ftree-vectorize -DUSE_PTHREADS \
  -I. -DNO_BLAS_WRAP -DADD_ -Iext/clapack/include -Iext/cblas/include \
  -Iext/kissfft -Iext/kissfft/tools -Dkiss_fft_scalar=double"
make -C qm-dsp -f build/linux/Makefile.linux64 \
  CFLAGS="$DSPFLAGS" CXXFLAGS="$DSPFLAGS -std=c++98"

cd qm
SRCS="g2cstubs.c plugins/AdaptiveSpectrogram.cpp plugins/BarBeatTrack.cpp \
  plugins/BeatTrack.cpp plugins/DWT.cpp plugins/OnsetDetect.cpp \
  plugins/ChromagramPlugin.cpp plugins/ConstantQSpectrogram.cpp \
  plugins/KeyDetect.cpp plugins/MFCCPlugin.cpp plugins/SegmenterPlugin.cpp \
  plugins/SimilarityPlugin.cpp plugins/TonalChangeDetect.cpp \
  plugins/Transcription.cpp libmain.cpp"
make -f build/linux/Makefile.linux64 qm-vamp-plugins.so \
  QM_DSP_DIR=../qm-dsp \
  CFLAGS="-DNDEBUG -O3 -fPIC -DUSE_PTHREADS -I. -I../qm-dsp -I/usr/include" \
  CXXFLAGS="-DNDEBUG -O3 -fPIC -DUSE_PTHREADS -I. -I../qm-dsp -I/usr/include" \
  LDFLAGS="-L../qm-dsp -shared -Wl,--no-undefined -lqm-dsp -lpthread -lvamp-sdk -Wl,--version-script=vamp-plugin.map" \
  SOURCES="$SRCS"
cp qm-vamp-plugins.so ~/.vamp/
```

说明：Vamp SDK 源码树用系统 `libvamp-sdk.so` 代（加 `-lvamp-sdk`），
直指 `qm-vamp-plugins.so` 目标以跳过子 make 的 sse 重编。

## 4. 验证（一次全过才算数）

```bash
export VAMP_PATH="$HOME/.vamp"
python3 -c "import vamp; print([p for p in vamp.list_plugins() if 'pyin' in p or 'qm-' in p])"
# 起音冒烟（16kHz 单声道 WAV）：sensitivity=20 期望 20~40 个 raw onsets
```

## 5. 服务生效

`vamp_features.py` 已 `os.environ.setdefault("VAMP_PATH", "~/.vamp")`，
`analysis_service/server.py` 每次分析自动 `extract_all`，失败即降级。
改完代码后重启服务：

```bash
pkill -f 'analysis_service.server' ; sleep 1
cd /home/ubuntu/n/scorefollow && nohup python3 -m analysis_service.server >/tmp/sf-analysis-8765.log 2>&1 &
curl -s http://127.0.0.1:8765/health
```

## 6. 已知坑位（实测记录）

- pYIN `smoothedpitchtrack` 定步长向量的时间戳直接外推会漂移；
  `notes` 输出的时间戳与音频核对无误——引擎只吃 `notes`（见 `_hint_track`）。
- pYIN 音符段取平均会抹掉短促偏差（如 +25¢ 只剩 +5¢），自研原始跟踪
  对这类更敏感；已融合（`_hint_track`：自研高置信帧打底 + pYIN 补盲区），
  sensors 记为 `fused-pitch`。不要二选一。
- QM 起音 `sensitivity` 反直觉：值越小越少（20≈27 个，50≈37 个，80≈120 个）；
  本机配方 sensitivity=20 + 150 ms 并档，14 个真实起音全中。
- `sync_mode="vamp-beat"`（活网格）：谱面相对拍→QM 拍点时间轴分段线性映射，
  稳速材料上节奏 79→97（《小星星》实测），detectedBpm 一并回传。
  强 rubato（±12%）下拍点跟踪会漂移，错位音符按 uncertain 排除、照实打分。
  教训：逐音符锚定的 warp 让期望与实测同源、节奏分恒满分——不可用，已删；
  节奏分必须以独立周期网格为参考才有意义。
- `vamp.collect` 的 dict 键有 `RealTime` 类型，`float()` 转后再算；
  `notes["list"]` 项是 dict（timestamp/duration/values[Hz]）。

## 7. 依赖与降级字段

- 必需依赖见 `analysis_service/requirements.txt`（`numpy`、`mido`）；`vamp`
  仅为可选插件桥，缺失时自动降级，测试环境无需安装。
- 降级状态显式回传（不只记日志）：`result["summary"]["degraded"]`（bool）与
  `result["summary"]["degradedReasons"]`（如 `pitch:builtin`、`onset:builtin`、
  `beat:legacy`），由本次实际传感器可用性推导；三路全中时 `degraded` 为
  false 且 reasons 为空。`sensors` 等既有字段保持不变。
