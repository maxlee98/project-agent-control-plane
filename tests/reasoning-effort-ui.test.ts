import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const component = fs.readFileSync(new URL("../src/components/ControlPlane.tsx", import.meta.url), "utf8");

test("keeps the reasoning effort selector in the task detail rail", () => {
  assert.match(component, /const \[reasoningEffort, setReasoningEffort\] = useState<ReasoningEffort \| "">\(""\);/);
  assert.match(component, /aria-labelledby="reasoning-effort-label"/);
  assert.match(component, /<label id="reasoning-effort-label" htmlFor="reasoning-effort"[^>]*>Reasoning effort<\/label>/);
  assert.match(component, /<select id="reasoning-effort"[^>]*value=\{reasoningEffort\}[^>]*onChange=\{\(event\) => setReasoningEffort\(/);
  assert.match(component, /<option value="">Default \/ unset<\/option>/);
  assert.match(component, /runtime\.reasoning\.supportedEfforts\.map\(\(effort\) =>/);
  assert.match(component, /runtime\.reasoning\.supportedEfforts\.length === 0/);

  const selectorIndex = component.indexOf('aria-labelledby="reasoning-effort-label"');
  const actionIndex = component.indexOf('<div className="mt-5 flex gap-2">');
  assert.notEqual(selectorIndex, -1);
  assert.notEqual(actionIndex, -1);
  assert.ok(selectorIndex < actionIndex, "the selector should appear before the run action controls");
});