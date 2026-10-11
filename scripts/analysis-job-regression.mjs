import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Transpile the pure state machine (no React/DOM) and load it as ESM,
// same pattern as scripts/analysis-guard-regression.mjs.
const source = readFileSync(new URL("../lib/analysis-job-state.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), "sf-analysis-job-"));
const modulePath = join(dir, "analysis-job-state.mjs");
writeFileSync(modulePath, output);
const sm = await import(pathToFileURL(modulePath));

const req = (over = {}) => ({
  musicxml: "<score/>",
  audioWavBase64: "AAA",
  instrument: "violin",
  bpm: 80,
  startMeasure: 1,
  ...over,
});

let clock = 1000;
const tick = () => (clock += 100);

// 1. 正常状态转换 idle → validating → preparing → submitting → polling → succeeded
{
  let s = { ...sm.initialJobState };
  assert.equal(s.status, "idle");
  s = sm.jobReducer(s, { type: "SUBMIT", request: req(), now: tick() });
  assert.equal(s.status, "validating");
  assert.equal(s.startedAt, clock);
  assert.equal(s.generation, 1);
  assert.ok(sm.LEGAL_TRANSITIONS.idle.includes("validating"));
  s = sm.jobReducer(s, { type: "VALIDATE_OK", now: tick() });
  assert.equal(s.status, "preparing");
  s = sm.jobReducer(s, { type: "PREPARE_DONE", now: tick() });
  assert.equal(s.status, "submitting");
  s = sm.jobReducer(s, { type: "SUBMIT_SUCCESS", jobId: "j1", now: tick() });
  assert.equal(s.status, "polling");
  assert.equal(s.jobId, "j1");
  assert.equal(s.pollCount, 0);
  s = sm.jobReducer(s, { type: "POLL_RESPONSE", jobId: "j1", status: "processing", progress: 30, now: tick() });
  assert.equal(s.status, "polling");
  assert.equal(s.progress, 30);
  assert.equal(s.pollCount, 1);
  assert.equal(s.remoteStatus, "processing");
  const done = sm.jobReducer(s, { type: "SUCCESS", jobId: "j1", result: { version: "1" }, now: tick() });
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.result, { version: "1" });
  assert.equal(done.elapsedMs, done.completedAt - done.startedAt);
  assert.ok(done.completedAt > done.startedAt);
  assert.ok(done.transitions.length >= 6);
  assert.ok(sm.isTerminalState(done.status));
  // 非法跃迁：idle 直接 SUCCESS 被忽略
  const idleSucc = sm.jobReducer(sm.initialJobState, { type: "SUCCESS", jobId: "x", result: {}, now: tick() });
  assert.equal(idleSucc.status, "idle");
}

// 前置校验
{
  assert.equal(sm.validateAnalysisRequest(req()), null);
  assert.ok(sm.validateAnalysisRequest(req({ musicxml: "", scoreXml: "" })));
  assert.ok(sm.validateAnalysisRequest(req({ audioWavBase64: "", audio: "" })));
  assert.ok(sm.validateAnalysisRequest(req({ bpm: 20 })));
  assert.ok(sm.validateAnalysisRequest(req({ bpm: 300 })));
  assert.ok(sm.validateAnalysisRequest(req({ startMeasure: -1 })));
  let s = sm.jobReducer(sm.initialJobState, { type: "SUBMIT", request: req(), now: tick() });
  s = sm.jobReducer(s, { type: "VALIDATE_FAIL", message: "bad", now: tick() });
  assert.equal(s.status, "failed");
  assert.equal(s.error.phase, "validating");
}

// 网络错误只记录不失败，允许重试
{
  let s = sm.jobReducer(sm.initialJobState, { type: "SUBMIT", request: req(), now: tick() });
  s = sm.jobReducer(s, { type: "VALIDATE_OK", now: tick() });
  s = sm.jobReducer(s, { type: "PREPARE_DONE", now: tick() });
  s = sm.jobReducer(s, { type: "SUBMIT_SUCCESS", jobId: "jn", now: tick() });
  s = sm.jobReducer(s, { type: "POLL_ERROR", message: "socket hang up", now: tick() });
  assert.equal(s.status, "polling");
  assert.equal(s.lastPollError, "socket hang up");
  const polls = s.pollCount;
  s = sm.jobReducer(s, { type: "SUCCESS", jobId: "jn", result: { version: "1" }, now: tick() });
  assert.equal(s.status, "succeeded");
  assert.ok(s.pollCount >= polls);
}

// 2. 取消时停止轮询并进入 cancelled（终端态后轮询被忽略）
{
  const machine = sm.createJobStateMachine();
  machine.dispatch({ type: "SUBMIT", request: req(), now: tick() });
  machine.dispatch({ type: "VALIDATE_OK", now: tick() });
  machine.dispatch({ type: "PREPARE_DONE", now: tick() });
  machine.dispatch({ type: "SUBMIT_SUCCESS", jobId: "jc", now: tick() });
  const cancelled = machine.dispatch({ type: "CANCEL", now: tick() });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.completedAt >= cancelled.startedAt);
  assert.ok(sm.isTerminalState(cancelled.status));
  assert.notEqual(cancelled.status, "failed");
  const after = machine.dispatch({ type: "POLL_RESPONSE", jobId: "jc", status: "processing", now: tick() });
  assert.equal(after.status, "cancelled");
}

// 3. 超时时停止轮询并进入 timed_out（不与 failed 混淆）
{
  let s = sm.jobReducer(sm.initialJobState, { type: "SUBMIT", request: req(), now: tick() });
  s = sm.jobReducer(s, { type: "VALIDATE_OK", now: tick() });
  s = sm.jobReducer(s, { type: "PREPARE_DONE", now: tick() });
  s = sm.jobReducer(s, { type: "SUBMIT_SUCCESS", jobId: "jt", now: tick() });
  s = sm.jobReducer(s, { type: "TIMEOUT", now: tick() });
  assert.equal(s.status, "timed_out");
  assert.equal(s.error.phase, "polling");
  assert.notEqual(s.status, "failed");
  assert.notEqual(s.status, "cancelled");
}

// 4. 过期结果被拒绝（jobId 不匹配）
{
  let s = sm.jobReducer(sm.initialJobState, { type: "SUBMIT", request: req(), now: tick() });
  s = sm.jobReducer(s, { type: "VALIDATE_OK", now: tick() });
  s = sm.jobReducer(s, { type: "PREPARE_DONE", now: tick() });
  s = sm.jobReducer(s, { type: "SUBMIT_SUCCESS", jobId: "j-current", now: tick() });
  const staleSucc = sm.jobReducer(s, { type: "SUCCESS", jobId: "j-old", result: {}, now: tick() });
  assert.equal(staleSucc.status, "polling");
  assert.equal(staleSucc.staleRejectedCount, 1);
  const stalePoll = sm.jobReducer(s, { type: "POLL_RESPONSE", jobId: "j-old", status: "completed", now: tick() });
  assert.equal(stalePoll.status, "polling");
  assert.equal(stalePoll.staleRejectedCount, 1);
  const staleFail = sm.jobReducer(s, { type: "FAIL", message: "x", jobId: "j-old", now: tick() });
  assert.equal(staleFail.status, "polling");
  // 同一 jobId 重复轮询只更新进度计数，不重启任务
  const p1 = sm.jobReducer(s, { type: "POLL_RESPONSE", jobId: "j-current", status: "processing", progress: 10, now: tick() });
  const p2 = sm.jobReducer(p1, { type: "POLL_RESPONSE", jobId: "j-current", status: "processing", progress: 20, now: tick() });
  assert.equal(p2.status, "polling");
  assert.equal(p2.jobId, "j-current");
  assert.equal(p2.pollCount, p1.pollCount + 1);
}

// 6. 新任务提交时取消旧任务（旧 jobId 立刻失效）
{
  let s = sm.jobReducer(sm.initialJobState, { type: "SUBMIT", request: req(), now: tick() });
  s = sm.jobReducer(s, { type: "VALIDATE_OK", now: tick() });
  s = sm.jobReducer(s, { type: "PREPARE_DONE", now: tick() });
  s = sm.jobReducer(s, { type: "SUBMIT_SUCCESS", jobId: "j-old", now: tick() });
  const gen = s.generation;
  s = sm.jobReducer(s, { type: "SUBMIT", request: req({ bpm: 90 }), now: tick() });
  assert.equal(s.status, "validating");
  assert.equal(s.jobId, null);
  assert.equal(s.generation, gen + 1);
  // 旧任务的迟到成功不再被接受（非 polling 直接忽略）
  const late = sm.jobReducer(s, { type: "SUCCESS", jobId: "j-old", result: {}, now: tick() });
  assert.equal(late.status, "validating");
  // RESET 回到 idle 但世代递增，防止 ABA
  const reset = sm.jobReducer(late, { type: "RESET", now: tick() });
  assert.equal(reset.status, "idle");
  assert.ok(reset.generation > late.generation);
}

// 5. 组件卸载时清理定时器 + hook 防护机制（源码静态断言）
{
  const hookSrc = readFileSync(new URL("../app/hooks/useAnalysisJob.ts", import.meta.url), "utf8");
  assert.ok(hookSrc.includes("clearInterval"), "hook 必须清理轮询定时器");
  assert.ok(hookSrc.includes("clearTimeout"), "hook 必须清理超时定时器");
  assert.ok(hookSrc.includes(".abort()"), "hook 必须 abort 未完成请求");
  assert.ok(hookSrc.includes("return () =>"), "hook 必须有 effect 清理函数");
  assert.ok(hookSrc.includes("jobId !== jobId") || hookSrc.includes("jobId !== jobId") || hookSrc.includes("!== jobId"), "hook 必须校验 jobId 匹配");
  assert.ok(hookSrc.includes("TIMEOUT"), "hook 必须处理超时");
  assert.ok(hookSrc.includes("CANCEL"), "hook 必须支持取消");
  assert.ok(hookSrc.includes("POLL_ERROR") || hookSrc.includes("lastPollError"), "网络错误不得立即失败");
  const panelSrc = readFileSync(new URL("../app/PerformancePanel.tsx", import.meta.url), "utf8");
  assert.ok(panelSrc.includes("useAnalysisJob"), "PerformancePanel 必须使用新 hook");
  assert.ok(panelSrc.includes("analysisJob.cancel"), "面板必须接入取消");
  assert.ok(panelSrc.includes("jobTakeRef"), "面板必须绑定 take 与 job");
  assert.ok(!panelSrc.includes("analyzeAbortRef"), "旧的中止引用必须移除");
  assert.ok(!panelSrc.includes("for (let i = 0; i < 240; i++)"), "旧的轮询循环必须移除");
}

console.log("ANALYSIS_JOB_REGRESSION_PASS");
