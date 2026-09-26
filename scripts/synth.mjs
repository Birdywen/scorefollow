/**
 * 合成谱端到端真值回归 (plan 阶段 1, 第 1 层: 机器真值)。
 *
 * 程序生成已知几何的谱面 RGBA 缓冲(谱线/小节线/符干干扰), 经
 * countPixFromBuffer 跑完整流水线 drawRes→countVsys→findBarLines,
 * 与真值按容差带对比: 内部小节线 precision/recall、平均 x 偏差、
 * 系统数/系统框、符干零误报、双小节线保留。
 * 不依赖浏览器/PDF, 真值零争议: `node scripts/synth.mjs`。
 */
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "sf-synth-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: new URL(root).pathname, stdio: "inherit" },
);
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);

// ---------- 合成谱绘制 ----------
const W = 1000;
const STAFF_X1 = 20;
const STAFF_X2 = 979;
const SP = 10;
const TH = 2;

function makeBuf(h) {
  const buf = new Uint8ClampedArray(W * h * 4);
  buf.fill(255);
  return buf;
}
function px(buf, x, y) {
  const o = (y * W + x) * 4;
  buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0;
}
function hline(buf, y, x1 = STAFF_X1, x2 = STAFF_X2, th = TH) {
  for (let yy = y; yy < y + th; yy++)
    for (let x = x1; x <= x2; x++) px(buf, x, yy);
}
function vline(buf, x, y1, y2, th = TH) {
  for (let xx = x; xx < x + th; xx++)
    for (let y = y1; y <= y2; y++) px(buf, xx, y);
}
function system(buf, yTop, sp = SP) {
  for (let i = 0; i < 5; i++) hline(buf, yTop + i * sp);
}
/** 实心符头(椭圆) */
function head(buf, cx, cy, rx = 4, ry = 5) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1 && x >= 0 && y >= 0 && x < W) px(buf, x, y);
    }
}
/** 空心符头(环, 全音符/二分符头): 弧细, 行宽不足 headLo,  veto 恒不可见(用户豁免全音符) */
function headRing(buf, cx, cy, rx = 5, ry = 6, th = 2) {
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++)
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      const q = dx * dx + dy * dy;
      if (q <= 1 && q >= 1 - th / Math.min(rx, ry) && x >= 0 && y >= 0 && x < W) px(buf, x, y);
    }
}
/** 文本块(力度记号/歌词近似): 实心小矩形 */
function textBlock(buf, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) px(buf, xx, yy);
}
/** 上行符干(右上)/下行符干(左下), len 35 = 3.5sp */
function stemUp(buf, hx, hyTop, len = 35) { vline(buf, hx + 3, hyTop - len, hyTop, 2); }
function stemDown(buf, hx, hyBot, len = 35) { vline(buf, hx - 4, hyBot, hyBot + len, 2); }
/** 淡线: 只印上部 65%(下部褪色, rel≈0.65, 弱峰 0.7 抓不住) */
function faintBar(buf, x, yTop) { vline(buf, x, yTop, yTop + Math.round(sysHeight() * 0.65)); }
/** 多小节休止符横杠(粗横线, 纵贯检测看不见它) */
function restBar(buf, x1, x2, y) { hline(buf, y, x1, x2, 4); }
function sysHeight() { return 4 * SP; }

/** 套件定义: 真值小节线(内部)/符干干扰/系统顶 */
const SUITES = [
  {
    name: "single-system",
    h: 240,
    systems: [{ yTop: 100, bars: [200, 400, 600, 800], stems: [300, 500, 700] }],
  },
  {
    name: "two-system-double-bar",
    h: 260,
    systems: [
      { yTop: 60, bars: [150, 400, 650], stems: [275, 525] },
      { yTop: 160, bars: [250, 500, 700, 708], stems: [375] },
    ],
  },
  {
    // 大谱表误拆回归: 上下单谱表被纵贯小节线连住 → 必须并成 1 个系统。
    // (Passacaglia 末页: 高/低音行 gap 无空白, 小节线穿缝而过。)
    name: "grand-staff-linked",
    h: 330,
    systems: [
      { yTop: 60, bars: [], stems: [275, 525] },
      { yTop: 190, bars: [], stems: [375] },
    ],
    link: { bars: [150, 400, 650] },
    wantSystems: 1,
    wantFrame: [60, 230],
    wantBars: [150, 400, 650],
  },
  {
    // 逆向路线 Phase1: 音符风暴(16 分音符跑句 + 符梁), notemask 抠掉符头符干。
    name: "note-storm",
    h: 280,
    flags: { notemask: 1 },
    systems: [{
      yTop: 100, bars: [200, 400, 600, 800], stems: [],
      notes: [
        { x: 240, dy: 0, up: true }, { x: 275, dy: 10, up: true },
        { x: 320, dy: 20, up: false }, { x: 355, dy: 30, up: false },
        { x: 440, dy: 5, up: true }, { x: 475, dy: 15, up: true },
        { x: 520, dy: 25, up: false }, { x: 555, dy: 35, up: false },
        { x: 640, dy: 0, up: true }, { x: 675, dy: 20, up: true },
        { x: 720, dy: 10, up: false }, { x: 755, dy: 30, up: false },
      ],
    }],
  },
  {
    // 逆向路线 Phase2: 淡线抢救(600 只印上部 65%, rel≈0.65 < 弱峰 0.7)。
    name: "faint-bar",
    h: 240,
    flags: { notemask: 1, widrescue: 1 },
    systems: [{
      yTop: 100, bars: [200, 400, 600, 800], faint: [600], stems: [],
      notes: [{ x: 250, dy: 10, up: true }, { x: 700, dy: 30, up: false }],
    }],
  },
  {
    // Phase2 护栏: 宽 gap 里有孤立竖线伪影(无符头)会被抢救(诚实记录代价)。
    name: "artifact-rescued",
    h: 240,
    flags: { notemask: 1, widrescue: 1 },
    systems: [{ yTop: 100, bars: [200, 400, 800], want: [200, 400, 600, 800], stems: [], artifacts: [600] }],
  },
  {
    // Phase2 护栏: 宽 gap + 多休止横杠 → 整 gap 跳过, 不幻觉。
    // (注: 光杆竖线在 base 即 veto-proof(midWidth halo 读 3px), 真实谱面不存在,
    // 这里只放横杠, 测"不硬造"的契约; 抢救灵敏度由 artifact-rescued 刻画。)
    name: "multirest-quiet",
    h: 240,
    systems: [{ yTop: 100, bars: [200, 400, 900], stems: [], restbars: [[500, 800]] }],
  },
  {
    // 升号 veto 锁定: ♯(双短竖 + 双横杠)不得检出小节线。竖瓣高 2.7sp
    // (弱峰可达, 触发否决链), 横杠保证 twin 信号; 真升号瓣纵贯<0.85,
    // twin-run 护栏(Saint-Saens)不得放行此类。
    name: "sharp-sign",
    h: 240,
    systems: [{ yTop: 100, bars: [200, 400, 600, 800], stems: [], sharps: [300, 500, 700] }],
  },
  {
    // 全音符豁免锁定(用户要求): 空心符头弧细恒不可见, 邻线真线必须保留。
    name: "whole-note-keep",
    h: 240,
    systems: [{ yTop: 100, bars: [200, 300, 500, 700], stems: [], hollowHeads: [{ x: 290, dy: 20 }] }],
  },
  {
    // 力度记号安全锁定: 谱下 1.8sp 外文本块不得否决邻线真线(宽窗下延止于 1.5sp)。
    name: "dynamics-keep",
    h: 240,
    systems: [{ yTop: 100, bars: [200, 400, 600, 800], stems: [], textBlocks: [{ x: 494, dy: 58, w: 12, h: 6 }] }],
  },
  {
    // 纵贯符干否决锁定(259/716 类): 竖线纵穿谱表上下各外伸 1.2sp、上下符头
    // 附着 → 符干不得检出; 真线端部止于框(grand-staff-linked 另锁连接线)。
    name: "span-stem-kill",
    h: 240,
    systems: [{ yTop: 100, bars: [200, 400, 600, 800], stems: [], spanStems: [500], highHeads: [{ x: 503, dy: -14 }], lowHeads: [{ x: 497, dy: 54 }] }],
  },
];

function renderSuite(suite) {
  const buf = makeBuf(suite.h);
  for (const s of suite.systems) {
    system(buf, s.yTop);
    for (const bx of s.bars) if (!((s.faint ?? []).includes(bx))) vline(buf, bx, s.yTop, s.yTop + sysHeight());
    for (const sx of s.stems) vline(buf, sx, s.yTop, s.yTop + 25);
    for (const nt of (s.notes ?? [])) {
      head(buf, nt.x, s.yTop + nt.dy);
      if (nt.up) stemUp(buf, nt.x, s.yTop + nt.dy - 5);
      else stemDown(buf, nt.x, s.yTop + nt.dy + 5);
    }
    for (const fx of (s.faint ?? [])) faintBar(buf, fx, s.yTop);
    for (const rb of (s.restbars ?? [])) restBar(buf, rb[0], rb[1], s.yTop + Math.round(sysHeight() / 2));
    for (const ax of (s.artifacts ?? [])) vline(buf, ax, s.yTop + 5, s.yTop + 35);
    // 全纵贯符干(267 类): 符头可在杆左右 ±8、谱上 3sp/谱下 1.5sp, 宽窗专杀
    for (const sx of (s.fullStems ?? [])) vline(buf, sx, s.yTop, s.yTop + sysHeight());
    // 纵贯符干(259/716 类): 上下各超框 12px(1.2sp), 双侧 1sp 否决专杀
    for (const sx of (s.spanStems ?? [])) vline(buf, sx, s.yTop - 12, s.yTop + sysHeight() + 12);
    for (const xh of (s.highHeads ?? [])) head(buf, xh.x, s.yTop + xh.dy);
    for (const lh of (s.lowHeads ?? [])) head(buf, lh.x, s.yTop + lh.dy);
    for (const sh of (s.sideHeads ?? [])) head(buf, sh.x, s.yTop + sh.dy);
    for (const hh of (s.hollowHeads ?? [])) headRing(buf, hh.x, s.yTop + hh.dy);
    for (const tb of (s.textBlocks ?? [])) textBlock(buf, tb.x, s.yTop + tb.dy, tb.w, tb.h);
    // 升号: 双短竖(高 2.7sp, 间距 5px) + 双横杠(上下各一, 宽出竖瓣两侧)
    for (const hx of (s.sharps ?? [])) {
      vline(buf, hx - 2, s.yTop + 6, s.yTop + 33, 2);
      vline(buf, hx + 3, s.yTop + 6, s.yTop + 33, 2);
      hline(buf, s.yTop + 12, hx - 7, hx + 9, 2);
      hline(buf, s.yTop + 24, hx - 7, hx + 9, 2);
    }
  }
  if (suite.beam) {
    // 符梁: 连两根上行符干的顶端
    const s = suite.systems[0];
    hline(buf, suite.beam.y, suite.beam.x1, suite.beam.x2, 4);
  }
  if (suite.link) {
    // 纵贯笔画: 小节线穿过上下谱表之间的 gap(大谱表的物理连接证据)
    const y1 = suite.systems[0].yTop;
    const y2 = suite.systems[suite.systems.length - 1].yTop + sysHeight();
    for (const bx of suite.link.bars) vline(buf, bx, y1, y2);
  }
  return buf;
}

// ---------- 评测 ----------
let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name} ${detail}`); }
}

for (const suite of SUITES) {
  const buf = renderSuite(suite);
  const savedFlags = { notemask: legacy.legacyOpt.notemask, widrescue: legacy.legacyOpt.widrescue };
  if (suite.flags) Object.assign(legacy.legacyOpt, suite.flags);
  const r = legacy.countPixFromBuffer(W, suite.h, buf, 0);
  Object.assign(legacy.legacyOpt, savedFlags);
  const spatium = legacy.getSpatium();
  const tol = Math.max(2, 0.2 * spatium);
  console.log(`--- ${suite.name}: systems=${r.cxs.length} spatium=${spatium} tol=${tol.toFixed(1)}`);

  check(`${suite.name}/system-count`, r.cxs.length === (suite.wantSystems ?? suite.systems.length),
    `got ${r.cxs.length}, want ${suite.wantSystems ?? suite.systems.length}`);
  check(`${suite.name}/spatium-sane`, spatium >= 8 && spatium <= 12, `spatium=${spatium}`);

  if (suite.link) {
    // 并带期望: 多个单谱表合成一个系统
    const tag = `${suite.name}/merged`;
    const sys = r.cxs[0];
    const det = r.bxs[0] ?? [];
    if (!sys || !det.length) { check(`${tag}/detected`, false, "no bars"); }
    else {
      check(`${tag}/frame-y`, Math.abs(sys.cs[0] - suite.wantFrame[0]) <= 3 &&
        Math.abs(sys.cs[sys.cs.length - 1] - suite.wantFrame[1]) <= 3,
        `cs=[${sys.cs[0]},${sys.cs[sys.cs.length - 1]}] want [${suite.wantFrame}]`);
      check(`${tag}/endpoints`, Math.abs(det[0] - STAFF_X1) <= 4 && Math.abs(det[det.length - 1] - STAFF_X2) <= 4,
        `ends=[${det[0]},${det[det.length - 1]}]`);
      const internal = det.slice(1, -1).sort((a, b) => a - b);
      const want = suite.wantBars.slice().sort((a, b) => a - b);
      const used = new Array(internal.length).fill(false);
      let tp = 0; let devSum = 0;
      for (const w of want) {
        let bi = -1; let bd = Infinity;
        internal.forEach((d, i) => {
          if (used[i]) return;
          const dd = Math.abs(d - w);
          if (dd <= tol && dd < bd) { bd = dd; bi = i; }
        });
        if (bi >= 0) { used[bi] = true; tp++; devSum += bd; }
      }
      const fp = used.filter((u) => !u).length;
      console.log(`    want=[${want}] got=[${internal}] tp=${tp} fp=${fp} fn=${want.length - tp}`);
      check(`${tag}/recall-100`, tp === want.length, `tp=${tp}`);
      check(`${tag}/precision-100`, fp === 0, `fp=${fp}`);
      const allStems = suite.systems.flatMap((s) => s.stems);
      const nearStem = internal.filter((d) => allStems.some((sx) => Math.abs(d - sx) <= 10 || Math.abs(d - (sx + 1)) <= 10));
      check(`${tag}/no-stem-false-positive`, nearStem.length === 0, `near-stem=${nearStem}`);
    }
  } else {
  suite.systems.forEach((s, si) => {
    const det = r.bxs[si] ?? [];
    const sys = r.cxs[si];
    const tag = `${suite.name}/sys${si + 1}`;
    if (!sys || !det.length) { check(`${tag}/detected`, false, "no bars"); return; }
    // 系统框
    check(`${tag}/frame-y`, Math.abs(sys.cs[0] - s.yTop) <= 3 && Math.abs(sys.cs[sys.cs.length - 1] - (s.yTop + sysHeight())) <= 3,
      `cs=[${sys.cs[0]},${sys.cs[sys.cs.length - 1]}] want [${s.yTop},${s.yTop + sysHeight()}]`);
    // 端点≈谱面左右边
    check(`${tag}/endpoints`, Math.abs(det[0] - STAFF_X1) <= 4 && Math.abs(det[det.length - 1] - STAFF_X2) <= 4,
      `ends=[${det[0]},${det[det.length - 1]}]`);
    // 内部小节线贪心匹配(want 覆盖 bars: 抢救类用例的真值含被救线)
    const internal = det.slice(1, -1).sort((a, b) => a - b);
    const want = (s.want ?? s.bars).slice().sort((a, b) => a - b);
    const used = new Array(internal.length).fill(false);
    let tp = 0; let devSum = 0;
    for (const w of want) {
      let bi = -1; let bd = Infinity;
      internal.forEach((d, i) => {
        if (used[i]) return;
        const dd = Math.abs(d - w);
        if (dd <= tol && dd < bd) { bd = dd; bi = i; }
      });
      if (bi >= 0) { used[bi] = true; tp++; devSum += bd; }
    }
    const fp = used.filter((u) => !u).length;
    const fn = want.length - tp;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = want.length === 0 ? 1 : tp / want.length;
    const meanDev = tp ? devSum / tp : 0;
    console.log(`    want=[${want}] got=[${internal}] tp=${tp} fp=${fp} fn=${fn} meanDev=${meanDev.toFixed(2)}`);
    check(`${tag}/recall-100`, recall === 1, `recall=${recall}`);
    check(`${tag}/precision-100`, precision === 1, `precision=${precision}`);
    check(`${tag}/mean-dev`, meanDev <= tol, `meanDev=${meanDev.toFixed(2)}`);
    // 符干零误报(短符干 stems + 全纵贯符干 fullStems + 纵贯符干 spanStems)
    const allStems = [...(s.stems ?? []), ...(s.fullStems ?? []), ...(s.spanStems ?? [])];
    const nearStem = internal.filter((d) => allStems.some((sx) => Math.abs(d - sx) <= 10 || Math.abs(d - (sx + 1)) <= 10));
    check(`${tag}/no-stem-false-positive`, nearStem.length === 0, `near-stem=${nearStem}`);
    // 升号零误报(双竖任一半 ±8 内不得有检出)
    const nearSharp = internal.filter((d) => (s.sharps ?? []).some((sx) => Math.abs(d - sx) <= 8));
    check(`${tag}/no-sharp-false-positive`, nearSharp.length === 0, `near-sharp=${nearSharp}`);
  });
  }
}

if (failures) { console.error(`${failures} synth check(s) failed`); process.exit(1); }
console.log("SYNTH_PASS");
