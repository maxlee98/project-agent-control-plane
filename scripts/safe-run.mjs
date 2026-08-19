#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GUARD_FAILURE = 78;
const TIMEOUT_FAILURE = 124;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;

function fail(message, code = GUARD_FAILURE) {
  process.stderr.write(`[safe-run] ${message}\n`);
  process.exit(code);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) return null;
  return args[index + 1];
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function basename(command) {
  return path.basename(command).toLowerCase();
}

function isShell(command) {
  return new Set(["sh", "bash", "zsh", "dash", "ksh"]).has(basename(command));
}

function isPython(command) {
  return /^python(?:3(?:\.\d+)?)?$/.test(basename(command));
}

function containsAny(value, patterns) {
  return patterns.find((pattern) => pattern.test(value)) ?? null;
}

function inspectCommand(command, commandArgs) {
  const all = [command, ...commandArgs];
  const joined = all.join(" ");
  const forbidden = containsAny(joined, [
    /<</,
    /\bcat\s+>>?\s*/,
    /\beval\b/,
    /\$\([^)]*\)/,
    /`[^`]*`/,
    /\b(?:quote|dquote|heredoc)>/,
  ]);
  if (forbidden) throw new Error(`unsafe shell/input pattern: ${forbidden}`);

  if (isShell(command)) {
    if (commandArgs.includes("-c") || commandArgs.includes("--command") || commandArgs.includes("-i") || commandArgs.includes("--interactive")) {
      throw new Error("shell -c/-i is forbidden; create an inspected script file and run it directly");
    }
    if (commandArgs.some((value) => isShell(value))) throw new Error("nested shells are forbidden");
    if (joined.includes("&&") || joined.includes("||") || joined.includes(";")) throw new Error("shell command chains are forbidden");
  }

  if (isPython(command)) {
    if (commandArgs.length === 0 || commandArgs.includes("-") || commandArgs.includes("-c") || commandArgs.includes("--command")) {
      throw new Error("Python REPL/stdin/-c is forbidden; run a patch-created .py script directly");
    }
  }

  if ((basename(command) === "node" || basename(command) === "nodejs") && (commandArgs.includes("-e") || commandArgs.includes("--eval"))) {
    throw new Error("Node inline evaluation is forbidden; run an inspected script file directly");
  }

  const directScript = commandArgs.find((value) => /\.(?:sh|bash|zsh|py)$/.test(value) && fs.existsSync(value));
  if (!directScript) return;
  const source = fs.readFileSync(directScript, "utf8");
  const unsafeScript = containsAny(source, [
    /<</,
    /\bcat\s+>>?\s*/,
    /\beval\b/,
    /\b(?:python3?|bash|sh|zsh)\s+-\s*/,
  ]);
  if (unsafeScript) throw new Error(`unsafe pattern in script ${directScript}: ${unsafeScript}`);
}

function parseInvocation(rawArgs) {
  const separator = rawArgs.indexOf("--");
  if (separator < 0) throw new Error("usage: safe-run --timeout-ms <ms> [--max-output-bytes <bytes>] -- <command> [args...]");
  const options = rawArgs.slice(0, separator);
  const commandParts = rawArgs.slice(separator + 1);
  if (commandParts.length === 0) throw new Error("a command is required after --");
  const timeoutValue = valueAfter(options, "--timeout-ms");
  if (!timeoutValue) throw new Error("--timeout-ms is required");
  const outputValue = valueAfter(options, "--max-output-bytes");
  return {
    timeoutMs: positiveInteger(timeoutValue, "--timeout-ms"),
    maxOutputBytes: outputValue ? positiveInteger(outputValue, "--max-output-bytes") : DEFAULT_OUTPUT_BYTES,
    command: commandParts[0],
    commandArgs: commandParts.slice(1),
  };
}

function terminate(child, signal) {
  if (!child.pid || child.killed) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function run({ command, commandArgs, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { detached: process.platform !== "win32", shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let outputBytes = 0;
    let outputOverflow = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let killTimer;

    const capture = (chunk, target) => {
      if (outputOverflow) return;
      const text = chunk.toString();
      const bytes = Buffer.byteLength(text);
      if (outputBytes + bytes > maxOutputBytes) {
        outputOverflow = true;
        stderr += "[safe-run] output limit exceeded; terminating process group\n";
        terminate(child, "SIGTERM");
        killTimer = setTimeout(() => terminate(child, "SIGKILL"), 1000);
        return;
      }
      outputBytes += bytes;
      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stderr += `[safe-run] timeout after ${timeoutMs}ms; terminating process group\n`;
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => terminate(child, "SIGKILL"), 1000);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      stderr += `[safe-run] ${error.message}\n`;
      resolve({ code: 127, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      const resultCode = timedOut || outputOverflow ? (timedOut ? TIMEOUT_FAILURE : GUARD_FAILURE) : (code ?? 1);
      resolve({ code: resultCode, stdout, stderr: signal ? `${stderr}[safe-run] child ended with ${signal}\n` : stderr });
    });
  });
}

let invocation;
try {
  invocation = parseInvocation(process.argv.slice(2));
  inspectCommand(invocation.command, invocation.commandArgs);
} catch (error) {
  fail(error instanceof Error ? error.message : "invalid invocation");
}

if (invocation) {
  const result = await run(invocation);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}