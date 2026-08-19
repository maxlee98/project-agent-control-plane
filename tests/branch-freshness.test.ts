import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFreshComparison, freshnessErrors } from "../scripts/branch-freshness.mjs";

test("accepts ahead and identical branches", () => {
  assert.deepEqual(freshnessErrors({ status: "ahead", ahead_by: 3, behind_by: 0 }, "main", "feature"), []);
  assert.doesNotThrow(() => assertFreshComparison({ status: "identical", ahead_by: 0, behind_by: 0 }, "main", "feature"));
});

test("rejects behind and diverged branches", () => {
  assert.throws(() => assertFreshComparison({ status: "behind", ahead_by: 0, behind_by: 2 }, "main", "feature"), /behind/);
  assert.throws(() => assertFreshComparison({ status: "diverged", ahead_by: 1, behind_by: 1 }, "main", "feature"), /diverged/);
});