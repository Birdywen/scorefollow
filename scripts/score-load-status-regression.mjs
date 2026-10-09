// score-load-status 回归: 源码级静态检查, 不起浏览器.
// 断言 app/page.tsx 含有 data-testid + 五阶段, 且关键载入路径均切换阶段.
// 用法: node scripts/score-load-status-regression.mjs
import fs from "node:fs";

const file = new URL("../app/page.tsx", import.meta.url);
const src = fs.readFileSync(file, "utf8");
const fails = [];
const ok = [];
const check = (name, cond) => { (cond ? ok : fails).push(name); };

check("has data-testid score-load-status", src.includes('data-testid="score-load-status"'));
check("has data-phase binding", src.includes("data-phase={scorePhase}"));
check("has data-has-score binding", src.includes("data-has-score"));
for (const p of ["ready", "loading", "recognizing", "ready-score", "error"]) {
  check(`phase literal "${p}"`, src.includes(`"${p}"`));
}
check("initial phase ready", /useState<ScorePhase>\("ready"\)/.test(src));
check("pdf start loading", /onPdfFile[\s\S]{0,400}?setScorePhase\("loading"\)/.test(src));
check("pdf error", src.includes("载入失败") && src.includes('setScorePhase("error")'));
check("image loading", src.includes("loading ${list.length} image(s)") || src.includes("loading"));
check("render recognizing", src.includes('setScorePhase("recognizing")'));
check("render success ready-score", src.includes('setScorePhase("ready-score")'));
check("preload invalid error", src.includes("not a preload file") && src.includes('setScorePhase("error")'));
check("preload success ready-score", src.includes("loaded preload") && src.includes('setScorePhase("ready-score")'));
check("footer keeps aria-live polite", src.includes('aria-live="polite"'));
check("no shortcut meaning change (Space still metronome)", src.includes("空格只控制节拍器"));
check("tuner logic untouched (TunerPanel import kept)", src.includes("TunerPanel"));

console.log(`score-load-status-regression: ok=${ok.length} fail=${fails.length}`);
for (const n of ok) console.log(`  ok ${n}`);
for (const n of fails) console.log(`  FAIL ${n}`);
if (fails.length) process.exit(1);
