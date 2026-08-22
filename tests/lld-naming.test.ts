import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const lldDirectory = "LLD";
const issueFirstFilename = /^\d+-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const legacyLlds = new Set([
  "agent-liveness-and-project-deduplication.md",
  "branch-freshness-enforcement.md",
  "pr-first-development-and-template.md",
  "pr-template-enforcement.md",
  "scripted-edit-reliability.md",
  "skill-hardening.md",
  "standardize-api-validation-idempotency-error-contracts.md",
  "terminal-hard-stop-enforcement.md",
]);

const filenames = fs.readdirSync(lldDirectory).filter((filename) => filename.endsWith(".md"));

function issueNumberFromFilename(filename: string) {
  return filename.match(/^(\d+)-/)?.[1] ?? null;
}

test("Issue-backed LLDs use an issue-first filename", () => {
  const currentLlds = filenames.filter((filename) => !legacyLlds.has(filename));

  assert.ok(currentLlds.length > 0, "expected Issue-backed LLDs in the directory");
  for (const filename of currentLlds) {
    assert.match(filename, issueFirstFilename, `LLD filename is missing its Issue prefix: ${filename}`);
    const issueNumber = issueNumberFromFilename(filename);
    assert.ok(issueNumber, `LLD filename is missing its Issue number: ${filename}`);
    const content = fs.readFileSync(`${lldDirectory}/${filename}`, "utf8");
    assert.match(content, new RegExp(`(?:Issue\\s+#?${issueNumber}\\b|#${issueNumber}\\b|issues/${issueNumber}\\b)`), `LLD does not identify its filename Issue: ${filename}`);
  }
  assert.equal(
    filenames.includes("23-llds-should-have-the-issue-tagged-to-them.md"),
    true,
    "the current task LLD must use its canonical Issue-prefixed filename",
  );
});

test("legacy LLD exceptions are explicit and contain no unexpected files", () => {
  for (const filename of legacyLlds) {
    assert.equal(filenames.includes(filename), true, `documented legacy LLD is missing: ${filename}`);
  }
  for (const filename of filenames) {
    if (!issueFirstFilename.test(filename)) assert.equal(legacyLlds.has(filename), true, `undocumented LLD filename exception: ${filename}`);
  }
});