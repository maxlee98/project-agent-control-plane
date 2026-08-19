import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runner = path.resolve("scripts/safe-run.mjs");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-safe-run-"));
const temporaryFiles: string[] = [];

function script(extension: string, source: string) {
  const file = path.join(temporaryDirectory, `case-${temporaryFiles.length}${extension}`);
  fs.writeFileSync(file, source);
  temporaryFiles.push(file);
  return file;
}

function invoke(...args: string[]) {
  return spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 5000 });
}

function guarded(command: string, ...args: string[]) {
  return invoke("--timeout-ms", "1000", "--", command, ...args);
}

after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("rejects shell, Python, heredoc, and redirection command shapes before spawn", () => {
  const redirectionTarget = path.join(temporaryDirectory, "redirection-target.txt");
  for (const invocation of [
    guarded("bash", "-c", "printf unsafe"),
    guarded("python3", "-c", "print('unsafe')"),
    guarded("python3", "-"),
    guarded("printf", "<<EOF"),
    guarded("cat", ">", redirectionTarget),
  ]) {
    assert.equal(invocation.status, 78);
    assert.match(invocation.stderr, /safe-run/);
  }
});

test("rejects unsafe content in a patch-created shell script", () => {
  const unsafeScript = script(".sh", "#!/bin/sh\ncat > target.txt\n");
  const invocation = guarded("bash", unsafeScript);
  assert.equal(invocation.status, 78);
  assert.match(invocation.stderr, /unsafe pattern in script/);
});

test("runs an inspected direct script with stdin closed", () => {
  const safeScript = script(".mjs", "import fs from 'node:fs';\nconst input = fs.readFileSync(0, 'utf8');\nprocess.stdout.write(`stdin-bytes-${input.length}`);\n");
  const invocation = guarded(process.execPath, safeScript);
  assert.equal(invocation.status, 0);
  assert.equal(invocation.stdout, "stdin-bytes-0");
});

test("terminates a timed-out child and caps excessive output", () => {
  const hangingScript = script(".mjs", "setTimeout(() => {}, 10000);\n");
  const timedOut = invoke("--timeout-ms", "100", "--", process.execPath, hangingScript);
  assert.equal(timedOut.status, 124);
  assert.match(timedOut.stderr, /timeout after 100ms/);

  const noisyScript = script(".mjs", "process.stdout.write('x'.repeat(10000));\n");
  const capped = invoke("--timeout-ms", "1000", "--max-output-bytes", "1000", "--", process.execPath, noisyScript);
  assert.equal(capped.status, 78);
  assert.match(capped.stderr, /output limit exceeded/);
});