import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const component = fs.readFileSync(new URL("../src/components/ControlPlane.tsx", import.meta.url), "utf8");

test("exposes the review-gated follow-up action and editable proposal controls", () => {
  assert.match(component, /Recommend follow-ups/);
  assert.match(component, /task\.status === "done" \|\| task\.status === "human_review"/);
  assert.match(component, /Add manual proposal/);
  assert.match(component, /Select \$\{proposal\.title \|\| "manual proposal"\}/);
  assert.match(component, /Review \$\{selected\.size \|\| "selected"\} for creation/);
  assert.match(component, /Demo mode creates local Inbox tasks only/);
  assert.match(component, /noGithubRequest/);
  assert.match(component, /role="dialog" aria-modal="true"/);
});