/** Beethoven op.81a 扫描钢琴双谱表回归 (原版 synpdf.js 在此谱 94 系统/393 内部线)。
 * node scripts/beethoven-regression.mjs /path/to/IMSLP728751-PMLP1483-Beeth_op81a_EB4342.pdf
 * 需 python3 的 pymupdf；渲染宽度与页分析默认 pagewd=1000 相同。
 * 与原版有分歧的 7 条新检出均已逐条核对 PDF 切片为实体小节线。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pdf = process.argv[2];
if (!pdf) { console.error('usage: node scripts/beethoven-regression.mjs <Beethoven-op81a.pdf>'); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'sf-beethoven-'));
execFileSync('npx', ['tsc', 'lib/synpdf-legacy.ts', '--outDir', tmp,
  '--module', 'nodenext', '--target', 'es2020', '--moduleResolution', 'nodenext',
  '--declaration', 'false', '--sourceMap', 'false'], { cwd: root, stdio: 'inherit' });
const legacy = await import(pathToFileURL(join(tmp, 'synpdf-legacy.js')).href);
const py = `import sys,pymupdf
d=pymupdf.open(sys.argv[1]);p=d[int(sys.argv[2])];z=1000/p.rect.width
pix=p.get_pixmap(matrix=pymupdf.Matrix(z,z),alpha=False)
sys.stdout.buffer.write(pix.width.to_bytes(4,'little')+pix.height.to_bytes(4,'little')+pix.samples)
`;
const expectedSystems = [5,7,7,7,7,6,6,6,7,7,6,6,6,6,5,0];
const required = new Map([
  [1, [[3, 261], [3, 839]]], [2, [[3, 808]]], [4, [[1, 685], [6, 257]]],
  [5, [[1, 233], [2, 372], [3, 596]]], [10, [[1, 293], [7, 839]]],
  [12, [[5, 519]]],
]);
const originalMisses = new Map([
  [2, [[7,379]]], [3, [[3,342]]], [8, [[2,930], [5,491]]],
  [10, [[2,739], [3,296], [7,839]]],
]);
let totalSystems = 0, totalInternal = 0, failures = 0;
for (let page = 1; page <= 16; page++) {
  const raw = execFileSync('python3', ['-c', py, pdf, String(page - 1)], { maxBuffer: 15_000_000 });
  const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 8, j = 0; i < raw.length; i += 3, j += 4) {
    rgba[j] = raw[i]; rgba[j + 1] = raw[i + 1]; rgba[j + 2] = raw[i + 2]; rgba[j + 3] = 255;
  }
  const r = legacy.countPixFromBuffer(w, h, rgba, 0);
  const n = r.bxs.reduce((sum, row) => sum + Math.max(0, row.length - 2), 0);
  totalSystems += r.cxs.length; totalInternal += n;
  if (r.cxs.length !== expectedSystems[page - 1]) {
    console.error(`FAIL p${page} systems=${r.cxs.length} expected=${expectedSystems[page - 1]}`); failures++;
  }
  for (const [si, x] of [...(required.get(page) ?? []), ...(originalMisses.get(page) ?? [])]) {
    if (!(r.bxs[si - 1] ?? []).slice(1,-1).some(v => Math.abs(v - x) <= 4)) {
      console.error(`FAIL p${page} sys${si} true bar at x=${x}`); failures++;
    }
  }
  console.log(`p${page} systems=${r.cxs.length} internal=${n}`);
}
if (totalInternal !== 400) { console.error(`FAIL internal=${totalInternal} (expected 400)`); failures++; }
console.log(`TOTAL systems=${totalSystems} internal=${totalInternal} original=94/393 failures=${failures}`);
if (failures) process.exit(1);
