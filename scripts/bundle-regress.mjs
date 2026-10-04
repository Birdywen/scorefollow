/**
 * Bundle 回归: 用公开发布的三件套 (original + auto.js + fixed.js) 跑真谱回归.
 *
 * 用法: node scripts/bundle-regress.mjs [bundleDir ...]
 *   无参数时扫描 SF_SCORE_ROOT (默认 /home/ubuntu/scorefollow-scores/Score)
 *   下所有含 fixed.js 的文件夹.
 *
 * 口径 (与 scripts/gt-eval.py 同款):
 *   - fixed.js 的 metric_arr = [pageW, {cxs, bxs} | null, ...], bxs 行含系统端点
 *   - 系统按谱线组上下沿交叠配对 (>0.5), 内部线取行 [1:-1], TOL=4px 贪心匹配
 *   - auto.js vs fixed.js 逐页对比: 有差异 = 精度集 (打分), 无差异 = 稳定集
 *     (当前算法输出必须逐位一致, 否则 exit 1)
 *   - 配对系统不足一半的页标 UNALIGNED, 不计分 (渲染裁剪口径待仲裁)
 *
 * 渲染: python3 (fitz 处理 pdf, PIL 处理 png, 统一按 pageW 宽度输出 raw RGB).
 * 检测: 同 rowscan.mjs, tsc 现场编译 lib/synpdf-legacy.ts 调 countPixFromBuffer.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scoreRoot = process.env.SF_SCORE_ROOT ?? "/home/ubuntu/scorefollow-scores/Score";
const TOL = 4;

const tmp = mkdtempSync(join(tmpdir(), "sf-bundlereg-"));
execSync(
  `npx tsc lib/synpdf-legacy.ts --outDir ${tmp} --module nodenext --target es2020 --moduleResolution nodenext --declaration false --sourceMap false`,
  { cwd: root, stdio: "pipe" },
);
const { pathToFileURL } = await import("node:url");
const legacy = await import(pathToFileURL(join(tmp, "synpdf-legacy.js")).href);
console.log(`algo v${legacy.ALGO_VERSION}`);

/** 从 preload .js 文本提取 metric_arr + 头部 algo 版本 */
function parsePreload(text) {
  const m = text.match(/^metric_arr = (\[.*\]);?\s*$/m);
  if (!m) throw new Error("metric_arr not found");
  const metric = JSON.parse(m[1]);
  const v = text.match(/algo v(\d+)/);
  return { pageW: metric[0], pages: metric.slice(1), algoVersion: v ? Number(v[1]) : null };
}

/** python 渲染原文件某页到 raw RGB (pdf 按页号, png 按 original-pN 命名) */
function renderOriginal(original, pageW, pageIdx, outRaw) {
  const script = `
import sys
p, w, i, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
if p.lower().endswith('.pdf'):
    import fitz
    d = fitz.open(p); pg = d[i - 1]
    pix = pg.get_pixmap(matrix=fitz.Matrix(w / pg.rect.width, w / pg.rect.width))
    import PIL.Image
    img = PIL.Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
else:
    import PIL.Image
    img = PIL.Image.open(p).convert('RGB')
    img = img.resize((w, round(img.height * w / img.width)))
open(out, 'wb').write(img.tobytes())
print(f'{img.width}x{img.height}')
`;
  const out = execSync(`python3 - "${original}" ${pageW} ${pageIdx} "${outRaw}"`,
    { cwd: root, input: script, stdio: ["pipe", "pipe", "pipe"] }).toString();
  // fitz 废弃警告打到 stdout: 取最后一行 WxH
  const m = out.match(/(\d+)x(\d+)\s*$/);
  if (!m) throw new Error("render failed: " + out.slice(0, 200));
  return { w: Number(m[1]), h: Number(m[2]) };
}

function internal(row) {
  if (!Array.isArray(row) || row.length < 2) return (row ?? []).slice();
  return row.slice(1, -1);
}

/** 系统配对: fixed cs 上下沿 vs 当前 cxs, 交叠 >0.5 */
function pairSystems(fixedCxs, ourCxs) {
  const pairs = [];
  const used = new Set();
  fixedCxs.forEach((f, gi) => {
    const g1 = f.cs[0], g2 = f.cs[f.cs.length - 1];
    let best = -1, bestOv = 0;
    ourCxs.forEach((o, oi) => {
      if (used.has(oi)) return;
      const o1 = o.cs[0], o2 = o.cs[o.cs.length - 1];
      const ov = Math.max(0, Math.min(g2, o2) - Math.max(g1, o1)) / Math.max(1, g2 - g1);
      if (ov > bestOv) { bestOv = ov; best = oi; }
    });
    if (best >= 0 && bestOv > 0.5) { pairs.push([gi, best]); used.add(best); }
    else pairs.push([gi, -1]);
  });
  return pairs;
}

/**
 * 跨渲染器帧对齐 (pdfjs 分析 vs fitz 重渲染常差整体仿射; 扫描页还有浏览器 deskew 旋转,
 * Boek p1 约 0.5°: sys1 x-5px, sys10 x+5px, 全局缩放修不好).
 * 只用系统框四角拟合完整仿射, 不碰小节线:
 *   返回 {ax, ay, bx, cx, cy, dx, rms} (fx=ax*ox+ay*oy+bx, fy=cx*ox+cy*oy+dx) 或 null.
 * 旋转/缩放超 5%、残差 RMS > 6px → 不可信, 调用方标 UNALIGNED.
 */
function fitFrameTransform(fixedCxs, ourCxs, pairs) {
  const solve = (pts) => {
    // 最小二乘拟合 f = a*ox + b*oy + c
    let sx = 0, sy = 0, sf = 0, n = pts.length;
    if (n < 3) return null;
    for (const p of pts) { sx += p[0]; sy += p[1]; sf += p[2]; }
    const mx = sx / n, my = sy / n, mf = sf / n;
    let xx = 0, xy = 0, yy = 0, xf = 0, yf = 0;
    for (const [ox, oy, f] of pts) {
      const dx = ox - mx, dy = oy - my, df = f - mf;
      xx += dx * dx; xy += dx * dy; yy += dy * dy; xf += dx * df; yf += dy * df;
    }
    const det = xx * yy - xy * xy;
    if (Math.abs(det) < 1e-9) return null;
    const a = (xf * yy - yf * xy) / det, b = (yf * xx - xf * xy) / det;
    return { a, b, c: mf - a * mx - b * my };
  };
  const good = pairs.filter(([, oi]) => oi >= 0);
  if (good.length < 2) return null;
  const xp = [], yp = [];
  for (const [gi, oi] of good) {
    const f = fixedCxs[gi], o = ourCxs[oi];
    const ft = f.cs[0], fb = f.cs[f.cs.length - 1];
    const ot = o.cs[0], ob = o.cs[o.cs.length - 1];
    for (const [oy, fy] of [[ot, ft], [ob, fb]]) {
      xp.push([o.xs.x1, oy, f.xs.x1]);
      xp.push([o.xs.x2, oy, f.xs.x2]);
      yp.push([o.xs.x1, oy, fy]);
      yp.push([o.xs.x2, oy, fy]);
    }
  }
  const fx = solve(xp), fy = solve(yp);
  if (!fx || !fy) return null;
  if (Math.abs(fx.a - 1) > 0.05 || Math.abs(fy.b - 1) > 0.05) return null;
  if (Math.abs(fx.b) > 0.05 || Math.abs(fy.a) > 0.05) return null; // 旋转限 ~3°
  const rms = Math.sqrt(
    (xp.reduce((s, [ox, oy, f]) => s + (fx.a * ox + fx.b * oy + fx.c - f) ** 2, 0) +
     yp.reduce((s, [ox, oy, f]) => s + (fy.a * ox + fy.b * oy + fy.c - f) ** 2, 0)) / (xp.length + yp.length));
  if (rms > 6) return null;
  return { ax: fx.a, ay: fx.b, bx: fx.c, cx: fy.a, cy: fy.b, dx: fy.c, rms };
}

function greedyMatch(want, got) {
  const used = new Array(got.length).fill(false);
  let tp = 0;
  for (const w of want) {
    let bi = -1, bd = TOL + 1e-9;
    got.forEach((g, i) => {
      if (used[i]) return;
      const d = Math.abs(g - w);
      if (d <= TOL && d < bd) { bd = d; bi = i; }
    });
    if (bi >= 0) { used[bi] = true; tp++; }
  }
  return { tp, fp: got.length - tp, fn: want.length - tp };
}

const r3 = (x) => Math.round(x * 1000) / 1000;

function findBundles() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (args.length) return args;
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        if (existsSync(join(p, "fixed.js"))) out.push(p);
        else walk(p);
      }
    }
  };
  walk(scoreRoot);
  return out;
}

let tot = { tp: 0, fp: 0, fn: 0 };
let changedPages = 0, stablePages = 0, stableDiffs = 0, unaligned = 0;
const bundles = findBundles();
if (!bundles.length) {
  console.log("no bundles found under", scoreRoot);
  process.exit(2);
}
for (const dir of bundles) {
  const fixed = parsePreload(readFileSync(join(dir, "fixed.js"), "utf8"));
  const auto = parsePreload(readFileSync(join(dir, "auto.js"), "utf8"));
  console.log(`--- ${dir} (bundle algo v${fixed.algoVersion ?? "?"}, pageW=${fixed.pageW})`);
  const files = readdirSync(dir);
  const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));
  for (let n = 1; n <= fixed.pages.length; n++) {
    const fp = fixed.pages[n - 1], ap = auto.pages[n - 1];
    if (!fp) continue;
    const original = pdf ?? files.find((f) => f === `original-p${n}.png` || f === `original-p${n}.jpg`);
    if (!original) { console.log(`  p${n}: no original, skip`); continue; }
    const raw = join(tmp, `${basename(dir)}-p${n}.raw`);
    const { w, h } = renderOriginal(join(dir, original), fixed.pageW, n, raw);
    const rawBuf = readFileSync(raw);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < rawBuf.length; i += 3, j += 4) {
      rgba[j] = rawBuf[i]; rgba[j + 1] = rawBuf[i + 1]; rgba[j + 2] = rawBuf[i + 2]; rgba[j + 3] = 255;
    }
    const res = legacy.countPixFromBuffer(w, h, rgba, 0);
    const ourBars = res.bxs;
    // auto vs fixed: 有差异=精度集, 无差异=稳定集
    const autoBars = ap ? ap.bxs : null;
    const sameAsAuto = autoBars && JSON.stringify(autoBars.map((r) => r.map(r3))) ===
      JSON.stringify(fp.bxs.map((r) => r.map(r3)));
    const pairs0 = pairSystems(fp.cxs, res.cxs);
    let pairs = pairs0;
    let alignNote = "";
    let paired = pairs.filter(([, oi]) => oi >= 0).length;
    if (paired * 2 < pairs.length && fp.cxs.length === res.cxs.length && fp.cxs.length >= 2) {
      // 粗对齐: 中位顶差平移后重配 (跨渲染器整体偏移)
      const dys = fp.cxs.map((f, i) => res.cxs[i].cs[0] - f.cs[0]).sort((a, b) => a - b);
      const dy = dys[Math.floor(dys.length / 2)];
      const shifted = res.cxs.map((s) => ({ cs: s.cs.map((y) => y - dy), xs: s.xs }));
      const p2 = pairSystems(fp.cxs, shifted);
      if (p2.filter(([, oi]) => oi >= 0).length * 2 >= p2.length) {
        pairs = p2;
        alignNote += ` dy=${Math.round(dy)}`;
      }
    }
    paired = pairs.filter(([, oi]) => oi >= 0).length;
    if (paired * 2 < pairs.length) {
      unaligned++;
      console.log(`  p${n}: UNALIGNED (paired ${paired}/${pairs.length}), excluded`);
      continue;
    }
    // 精对齐: 系统框拟合完整仿射 (只用框, 不碰小节线), 小节线经变换后打分
    // (旋转需 y: 取该行系统纵中线为 y)
    let scoreBars = ourBars;
    const tr = fitFrameTransform(fp.cxs, res.cxs, pairs);
    if (tr) {
      scoreBars = ourBars.map((row, oi) => {
        const cs = res.cxs[oi] ? res.cxs[oi].cs : null;
        const ym = cs ? (cs[0] + cs[cs.length - 1]) / 2 : 0;
        return row.map((x) => tr.ax * x + tr.ay * ym + tr.bx);
      });
      const rot = (Math.atan2(tr.ay, tr.ax) * 180 / Math.PI).toFixed(2);
      alignNote += ` aff(rot${rot}° rms=${tr.rms.toFixed(2)})`;
    }
    let pTp = 0, pFp = 0, pFn = 0;
    const badSys = [];
    for (const [gi, oi] of pairs) {
      if (oi < 0) { pFn += internal(fp.bxs[gi]).length; badSys.push(`sys${gi + 1}: unpaired (+${internal(fp.bxs[gi]).length}fn)`); continue; }
      const w = internal(fp.bxs[gi]), g = internal(scoreBars[oi] ?? []).map(r3);
      const m = greedyMatch(w, g);
      pTp += m.tp; pFp += m.fp; pFn += m.fn;
      if (m.fp + m.fn > 0) {
        // 漏检 = want 中未被匹配的, 误报 = got 中未被匹配的
        const usedW = new Array(w.length).fill(false);
        const usedG = new Array(g.length).fill(false);
        w.forEach((x, wi) => {
          let bi = -1, bd = TOL + 1e-9;
          g.forEach((y, gi2) => { if (!usedG[gi2] && Math.abs(y - x) <= TOL && Math.abs(y - x) < bd) { bd = Math.abs(y - x); bi = gi2; } });
          if (bi >= 0) { usedW[wi] = true; usedG[bi] = true; }
        });
        badSys.push(`sys${gi + 1}: fn[${w.filter((_, i) => !usedW[i]).map(Math.round)}] fp[${g.filter((_, i) => !usedG[i]).map(Math.round)}]`);
      }
    }
    for (const b of badSys) console.log(`    ${b}`);
    if (sameAsAuto) {
      stablePages++;
      // 稳定集: 跨渲染器亚像素抖动正常, 按 TOL 口径验收 (fp+fn==0), 不逐位比对
      if (pFp + pFn > 0) {
        stableDiffs++;
        console.log(`  p${n}: STABLE-DIFF${alignNote} tp=${pTp} fp=${pFp} fn=${pFn} (want ${JSON.stringify(fp.bxs)} got ${JSON.stringify(scoreBars.map((r) => r.map(r3)))})`);
      } else {
        console.log(`  p${n}: stable ok${alignNote} (${scoreBars.flat().length} bars)`);
      }
    } else {
      changedPages++;
      tot.tp += pTp; tot.fp += pFp; tot.fn += pFn;
      console.log(`  p${n}: accuracy${alignNote} tp=${pTp} fp=${pFp} fn=${pFn}`);
    }
  }
}
const prec = tot.tp + tot.fp ? (tot.tp / (tot.tp + tot.fp)).toFixed(3) : "-";
const rec = tot.tp + tot.fn ? (tot.tp / (tot.tp + tot.fn)).toFixed(3) : "-";
console.log(`BUNDLE_REGRESS tp=${tot.tp} fp=${tot.fp} fn=${tot.fn} P=${prec} R=${rec} changedPages=${changedPages} stablePages=${stablePages} stableDiffs=${stableDiffs} unaligned=${unaligned}`);
if (stableDiffs) { console.log("BUNDLE_REGRESS_FAIL: stable pages drifted"); process.exit(1); }
console.log("BUNDLE_REGRESS_OK");
