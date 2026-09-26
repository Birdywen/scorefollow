// Exercise the actual page merge callback, including pages with no detected staff.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const mergeFromPages = useCallback(');
const end = source.indexOf('\n  }, []);', start);
assert.ok(start >= 0 && end > start, 'merge callback found');
const js = ts.transpileModule(source.slice(start, end + '\n  }, []);'.length), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const merge = new Function('autoRef', 'pageOffsetsRef', 'pageBarsFor', 'useCallback', `${js}; return mergeFromPages();`);
const content = { pageW: 1000, pageH: 1200, systems: [{ cs: [100, 200], xs: { x1: 50, x2: 950 } }], bars: [[50, 500, 950]], confidence: [1] };
function run(pages) {
  let y = 0;
  const offsets = pages.map((a, i) => { const off = { page: i + 1, y, h: a ? 1200 : 800, w: 1000 }; y += off.h; return off; });
  const autos = Object.fromEntries(pages.map((a, i) => [i + 1, a]));
  return merge({ current: autos }, { current: offsets }, (_, a) => a.bars, fn => fn);
}
assert.equal(run([content, null]).pageH, 2000, 'trailing text page occupies overlay height');
assert.deepEqual(run([null, content]).systems[0].cs, [900, 1000], 'cover does not hide or shift detected content');
assert.equal(run([content, null, content, null]).pageH, 4000, 'all displayed pages contribute height');
assert.equal(run([null, null]), null, 'empty score has no analysis');
console.log('PAGE_MERGE_REGRESSION_PASS');
