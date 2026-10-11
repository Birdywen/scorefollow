import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// 将 app/hooks/useTuner.ts 转译后提取纯函数 mapTunerMicError，
// 不加载 React/AudioContext，不 mock 浏览器/设备，确定性断言错误映射。
const sourceUrl = new URL("../app/hooks/useTuner.ts", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");

// 静态契约：常量/状态机/回调约定未被改动，原始错误保留供调试。
assert.match(source, /export const MIN_HZ = 55/);
assert.match(source, /export const MAX_HZ = 1400/);
assert.match(source, /export const IN_TUNE_CENTS = 6/);
assert.match(source, /export function mapTunerMicError/);
assert.match(source, /onError\?: \(error: string\)/);
assert.match(source, /dispatch\(\{ type: "START_FAIL", message \}\)/);
assert.match(source, /console\.debug\("\[tuner\] microphone error:"/);
assert.match(source, /const message = mapTunerMicError\(e\)/);

const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;

const marker = "export function mapTunerMicError";
const start = output.indexOf(marker);
assert.notEqual(start, -1, "mapTunerMicError not found in transpiled output");
const braceStart = output.indexOf("{", start);
assert.notEqual(braceStart, -1);
let depth = 0;
let end = -1;
for (let i = braceStart; i < output.length; i++) {
  if (output[i] === "{") depth++;
  else if (output[i] === "}") {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
assert.notEqual(end, -1, "unbalanced braces in mapTunerMicError");
const fnSource = output.slice(start, end);
const dir = mkdtempSync(join(tmpdir(), "sf-tuner-permission-"));
const modulePath = join(dir, "tuner-mic-error.mjs");
writeFileSync(modulePath, `${fnSource}\n`);
const { mapTunerMicError } = await import(pathToFileURL(modulePath));
assert.equal(typeof mapTunerMicError, "function");

const err = (name, message) => {
  const e = new Error(message);
  e.name = name;
  return e;
};

// 1. 权限拒绝：NotAllowedError / PermissionDeniedError
for (const name of ["NotAllowedError", "PermissionDeniedError"]) {
  const s = mapTunerMicError(err(name, "Permission denied"));
  assert.match(s, /权限被拒绝/);
  assert.match(s, /permission denied/i);
  assert.match(s, /上传/);
}

// 2. 无设备：NotFoundError / DevicesNotFoundError / OverconstrainedError
for (const name of ["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"]) {
  const s = mapTunerMicError(err(name, "Requested device not found"));
  assert.match(s, /未找到麦克风/);
  assert.match(s, /No microphone found/);
}

// 3. 占用/不可读：NotReadableError / TrackStartError
for (const name of ["NotReadableError", "TrackStartError"]) {
  const s = mapTunerMicError(err(name, "Could not start audio source"));
  assert.match(s, /正忙或不可用/);
  assert.match(s, /busy or unavailable/i);
}

// 4. 非安全上下文/不支持：原始不支持文案 + insecure + NotSupportedError
{
  const s1 = mapTunerMicError(new Error("浏览器不支持麦克风 / Microphone not supported"));
  assert.match(s1, /HTTPS\/localhost/);
  assert.match(s1, /unavailable on this page/i);
  const s2 = mapTunerMicError(err("NotSupportedError", "getUserMedia is not supported"));
  assert.match(s2, /HTTPS\/localhost/);
  const s3 = mapTunerMicError("getUserMedia is not available in insecure context");
  assert.match(s3, /HTTPS\/localhost/);
}

// 5. 未知错误：双语回退并保留原始信息
{
  const s = mapTunerMicError(err("Error", "boom-xyz-123"));
  assert.match(s, /boom-xyz-123/);
  assert.match(s, /启动失败/);
  assert.match(s, /failed to start/i);
}

// 6. 纯函数确定性：无浏览器依赖，重复调用一致，杂散输入不抛错
{
  const a = mapTunerMicError(err("NotAllowedError", "x"));
  const b = mapTunerMicError(err("NotAllowedError", "x"));
  assert.equal(a, b);
  assert.equal(typeof mapTunerMicError(undefined), "string");
  assert.equal(typeof mapTunerMicError(null), "string");
  assert.equal(typeof mapTunerMicError("plain string failure"), "string");
  assert.match(mapTunerMicError("plain string failure"), /plain string failure/);
}

console.log("TUNER_PERMISSION_REGRESSION_PASS");
