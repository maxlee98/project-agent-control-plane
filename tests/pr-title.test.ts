import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePrTitle, prTitleTypeFromLabels, validatePrTitle } from "../src/lib/pr-title.ts";

test("accepts supported Conventional Commit pull request titles", () => {
  assert.deepEqual(validatePrTitle("feat: add task filtering"), []);
  assert.deepEqual(validatePrTitle("fix(api)!: prevent duplicate handoffs"), []);
  assert.deepEqual(validatePrTitle("docs: document the PR workflow"), []);
});

test("rejects unprefixed, unsupported, and empty pull request titles", () => {
  assert.ok(validatePrTitle("Add task filtering").length > 0);
  assert.ok(validatePrTitle("improvement: add task filtering").some((error) => error.includes("unsupported")));
  assert.ok(validatePrTitle("fix:").length > 0);
  assert.ok(validatePrTitle(" ").length > 0);
});

test("selects a deterministic prefix from task labels", () => {
  assert.equal(prTitleTypeFromLabels(["product", "bug"]), "fix");
  assert.equal(prTitleTypeFromLabels(["documentation"]), "feat");
  assert.equal(prTitleTypeFromLabels(["docs", "product"]), "docs");
  assert.equal(normalizePrTitle("Repair the handoff", ["bug"]), "fix: Repair the handoff");
  assert.equal(normalizePrTitle("feat: add handoff", ["bug"]), "feat: add handoff");
});