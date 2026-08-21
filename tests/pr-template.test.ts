import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { assertValidPrBody, readTemplate, validatePrBody } from "../scripts/pr-template.mjs";

const template = readTemplate();
const validBody = template
  .replaceAll(/<!--.*?-->/gs, "")
  .replace("- **Task:** ", "- **Task:** Fixes #123 ")
  .replace("## UX evidence", "## UX evidence\n\nNot applicable: documentation and infrastructure change.")
  .replaceAll("- [ ] `npm test` — result:", "- [x] `npm test` — result: 15 passed")
  .replaceAll("- [ ] `npm run typecheck` — result:", "- [x] `npm run typecheck` — result: passed")
  .replaceAll("- [ ] `npm run build` — result:", "- [x] `npm run build` — result: passed")
  .replaceAll("- [ ] `git diff --check` — result:", "- [x] `git diff --check` — result: passed")
  .replaceAll("- [ ] No `.env`, `.env.local`, tokens, API keys, authorization headers, or sensitive raw logs were added.", "- [x] No `.env`, `.env.local`, tokens, API keys, authorization headers, or sensitive raw logs were added.");

test("accepts a complete PR template body", () => {
  assert.doesNotThrow(() => assertValidPrBody(template, validBody));
});

test("reports missing headings, unresolved comments, and unchecked validation", () => {
  const errors = validatePrBody(template, "## Problem\n<!-- unfinished -->\n");
  assert.ok(errors.some((error) => error.includes("missing heading")));
  assert.ok(errors.includes("unresolved template comment remains"));
  assert.ok(errors.includes("validation result is not checked: npm test"));
  assert.ok(errors.some((error) => error.includes("explicit canonical GitHub Issue linkage is missing")));
});

test("accepts a closing GitHub Issue reference as the PR linkage", () => {
  const body = validBody.replace("Fixes #123", "Closes #123");
  assert.doesNotThrow(() => assertValidPrBody(template, body));
});

test("rejects a URL-only Issue mention as non-linking", () => {
  const body = validBody.replace("Fixes #123", "https://github.com/example/repository/issues/123");
  const errors = validatePrBody(template, body);
  assert.ok(errors.some((error) => error.includes("explicit canonical GitHub Issue linkage is missing")));
});

test("rejects a Refs-only Issue mention as non-linking", () => {
  const body = validBody.replace("Fixes #123", "Refs #123");
  const errors = validatePrBody(template, body);
  assert.ok(errors.some((error) => error.includes("explicit canonical GitHub Issue linkage is missing")));
});

test("template remains the single source of truth", () => {
  assert.equal(fs.existsSync(".github/pull_request_template.md"), true);
  assert.ok(template.includes("## Reviewer checklist"));
});