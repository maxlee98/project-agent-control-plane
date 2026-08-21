import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const skillPath = ".agents/skills/content-size-protection/SKILL.md";
const installerPath = "scripts/install-content-size-protection.mjs";
const lldPath = "LLD/content-size-protection.md";
const workflowPath = "workflows/default/WORKFLOW.md";
const docsPath = "docs/terminal-reliability.md";

const skill = fs.readFileSync(skillPath, "utf8");
const installer = fs.readFileSync(installerPath, "utf8");
const lld = fs.readFileSync(lldPath, "utf8");
const workflow = fs.readFileSync(workflowPath, "utf8");
const docs = fs.readFileSync(docsPath, "utf8");

test("defines a discoverable content-size protection skill", () => {
  assert.match(skill, /^---\nname: content-size-protection\ndescription: .+\n---/);
  assert.match(skill, /48,000 characters/);
  assert.match(skill, /12,000 characters/);
  assert.match(skill, /16,000 characters/);
});

test("requires complete-request measurement and selective context", () => {
  for (const marker of [
    /system instructions/,
    /conversation history/,
    /tool definitions/,
    /tool results/,
    /UTF-8 bytes/,
    /estimate tokens as an approximation/,
    /targeted\s+searches and line ranges/,
    /Do not include `.env`, `.env.local`, credentials/,
  ]) {
    assert.match(skill, marker, `missing size-safety rule: ${marker}`);
  }
});

test("requires compaction/chunking and bounded OpenRouter recovery", () => {
  assert.match(skill, /compact persisted history before `send`\/resume/);
  assert.match(skill, /split it into one objective per request/);
  assert.match(skill, /403 Request blocked by content filter: Request content exceeds maximum size for content filtering/);
  assert.match(skill, /retry at most once/);
  assert.match(skill, /Do not classify this as success, retry the identical payload, loop indefinitely/);
});

test("keeps telemetry and installation secret-safe", () => {
  for (const marker of [
    /Record only component labels and counts/,
    /Never\s+log full prompts/,
    /Do not read, persist, or print `.env` files/,
    /fs\.renameSync\(temporary, target\)/,
    /global skill readback verification failed/,
  ]) {
    const source = marker.source.includes("fs\\.") || marker.source.includes("global skill") ? installer : `${skill}\n${lld}`;
    assert.match(source, marker, `missing safety marker: ${marker}`);
  }
});

test("is wired into repository workflow guidance", () => {
  assert.match(workflow, /content-size-protection\/SKILL\.md/);
  assert.match(docs, /content-size-protection/);
  assert.match(lld, /Status/);
  assert.match(lld, /Validation results/);
});