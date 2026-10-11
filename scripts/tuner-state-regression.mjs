import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Transpile the pure state machine (no React/DOM) and load it as ESM,
// same pattern as scripts/analysis-job-regression.mjs.
const source = readFileSync(new URL("../lib/tuner-state.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dir = mkdtempSync(join(tmpdir(), "sf-tuner-state-"));
const modulePath = join(dir, "tuner-state.mjs");
writeFileSync(modulePath, output);
const sm = await import(pathToFileURL(modulePath));

let clock = 1000;
const tick = () => (clock += 100);

const reading = (over = {}) => ({ note: "A4", cents: 3, hz: 440, ...over });

// 1. 正常流程：idle → requesting → running → stopping → stopped
{
  let s = { ...sm.initialTunerState };
  assert.equal(s.status, "idle");
  assert.equal(s.generation, 0);
  s = sm.tunerReducer(s, { type: "REQUEST_START", now: tick() });
  assert.equal(s.status, "requesting");
  assert.equal(s.generation, 1);
  assert.equal(s.error, null);
  assert.ok(sm.LEGAL_TRANSITIONS.idle.includes("requesting"));
  s = sm.tunerReducer(s, { type: "START_SUCCESS", now: tick() });
  assert.equal(s.status, "running");
  assert.equal(s.startedAt, clock);
  s = sm.tunerReducer(s, { type: "STOP", now: tick() });
  assert.equal(s.status, "stopping");
  s = sm.tunerReducer(s, { type: "STOP_DONE", now: tick() });
  assert.equal(s.status, "stopped");
  assert.equal(s.stoppedAt, clock);
}

// 2. 启动失败：idle → requesting → failed
{
  let s = { ...sm.initialTunerState };
  s = sm.tunerReducer(s, { type: "REQUEST_START", now: tick() });
  assert.equal(s.status, "requesting");
  s = sm.tunerReducer(s, { type: "START_FAIL", message: "denied", now: tick() });
  assert.equal(s.status, "failed");
  assert.equal(s.error, "denied");
}

// 3. 运行中收到 UPDATE_READING
{
  let s = { ...sm.initialTunerState };
  s = sm.tunerReducer(s, { type: "REQUEST_START", now: tick() });
  s = sm.tunerReducer(s, { type: "START_SUCCESS", now: tick() });
  s = sm.tunerReducer(s, { type: "UPDATE_READING", reading: reading(), now: tick() });
  assert.equal(s.status, "running");
  assert.deepEqual(s.reading, reading());
  s = sm.tunerReducer(s, { type: "UPDATE_READING", reading: reading({ note: "C4", cents: -5, hz: 261.6 }), now: tick() });
  assert.equal(s.reading.note, "C4");
  assert.equal(s.reading.cents, -5);
}

// 4. 运行中收到 CLEAR_READING（静音）
{
  let s = { ...sm.initialTunerState };
  s = sm.tunerReducer(s, { type: "REQUEST_START", now: tick() });
  s = sm.tunerReducer(s, { type: "START_SUCCESS", now: tick() });
  s = sm.tunerReducer(s, { type: "UPDATE_READING", reading: reading(), now: tick() });
  assert.notEqual(s.reading, null);
  s = sm.tunerReducer(s, { type: "CLEAR_READING", now: tick() });
  assert.equal(s.reading, null);
  assert.equal(s.status, "running");
}

// 5. 停止后再启动（RESET）
{
  let s = { ...sm.initialTunerState };
  s = sm.tunerReducer(s, { type: "REQUEST_START", now: tick() });
  s = sm.tunerReducer(s, { type: "START_SUCCESS", now: tick() });
  s = sm.tunerReducer(s, { type: "STOP", now: tick() });
  s = sm.tunerReducer(s, { type: "STOP_DONE", now: tick() });
  assert.equal(s.status, "stopped");
  const genBefore = s.generation;
  s = sm.tunerReducer(s, { type: "RESET", now: tick() });
  assert.equal(s.status, "idle");
  assert.equal(s.reading, null);
  assert.equal(s.error, null);
  assert.equal(s.generation, genBefore + 1);
  // 重启
  s = sm.tunerReducer(s, { type: "REQUEST_START", now: tick() });
  assert.equal(s.status, "requesting");
  s = sm.tunerReducer(s, { type: "START_SUCCESS", now: tick() });
  assert.equal(s.status, "running");
  assert.notEqual(s.startedAt, null);
}

// 6. 非法状态转换被忽略（如 idle 直接 UPDATE_READING）
{
  const idle = { ...sm.initialTunerState };
  assert.strictEqual(sm.tunerReducer(idle, { type: "UPDATE_READING", reading: reading(), now: tick() }), idle);
  assert.strictEqual(sm.tunerReducer(idle, { type: "CLEAR_READING", now: tick() }), idle);
  assert.strictEqual(sm.tunerReducer(idle, { type: "STOP", now: tick() }), idle);
  assert.strictEqual(sm.tunerReducer(idle, { type: "STOP_DONE", now: tick() }), idle);
  assert.strictEqual(sm.tunerReducer(idle, { type: "START_SUCCESS", now: tick() }), idle);
  assert.strictEqual(sm.tunerReducer(idle, { type: "START_FAIL", message: "x", now: tick() }), idle);

  // stopped 下的读数更新也被忽略
  let s = { ...sm.initialTunerState };
  s = sm.tunerReducer(s, { type: "REQUEST_START", now: tick() });
  s = sm.tunerReducer(s, { type: "START_SUCCESS", now: tick() });
  s = sm.tunerReducer(s, { type: "STOP", now: tick() });
  s = sm.tunerReducer(s, { type: "STOP_DONE", now: tick() });
  assert.strictEqual(sm.tunerReducer(s, { type: "UPDATE_READING", reading: reading(), now: tick() }), s);

  // running 中重复 REQUEST_START 被忽略（避免重复申请麦克风）
  let r = sm.tunerReducer({ ...sm.initialTunerState }, { type: "REQUEST_START", now: tick() });
  r = sm.tunerReducer(r, { type: "START_SUCCESS", now: tick() });
  assert.strictEqual(sm.tunerReducer(r, { type: "REQUEST_START", now: tick() }), r);
}

// 工厂函数（脱离 React）冒烟测试
{
  const m = sm.createTunerStateMachine();
  assert.equal(m.getState().status, "idle");
  m.dispatch({ type: "REQUEST_START", now: tick() });
  assert.equal(m.getState().status, "requesting");
  m.dispatch({ type: "START_SUCCESS", now: tick() });
  m.dispatch({ type: "UPDATE_READING", reading: reading(), now: tick() });
  assert.equal(m.getState().reading.note, "A4");
  m.reset(tick());
  assert.equal(m.getState().status, "idle");
}

console.log("TUNER_STATE_REGRESSION_PASS");
