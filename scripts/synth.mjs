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
];

function renderSuite(suite) {
  const buf = makeBuf(suite.h);
  for (const s of suite.systems) {
    system(buf, s.yTop);
    for (const bx of s.bars) vline(buf, bx, s.yTop, s.yTop + sysHeight());
    for (const sx of s.stems) vline(buf, sx, s.yTop, s.yTop + 25);
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
  const r = legacy.countPixFromBuffer(W, suite.h, buf, 0);
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
    // 内部小节线贪心匹配
    const internal = det.slice(1, -1).sort((a, b) => a - b);
    const want = s.bars.slice().sort((a, b) => a - b);
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
    // 符干零误报
    const nearStem = internal.filter((d) => s.stems.some((sx) => Math.abs(d - sx) <= 10 || Math.abs(d - (sx + 1)) <= 10));
    check(`${tag}/no-stem-false-positive`, nearStem.length === 0, `near-stem=${nearStem}`);
  });
  }
}

if (failures) { console.error(`${failures} synth check(s) failed`); process.exit(1); }
console.log("SYNTH_PASS");
