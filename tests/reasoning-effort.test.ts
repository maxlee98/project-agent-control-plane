import assert from "node:assert/strict";
import { test } from "node:test";
import { getReasoningCapability, validateReasoningEffort } from "../src/lib/server/reasoning.ts";
import { isReasoningEffort } from "../src/lib/domain.ts";

test("accepts only the SDK's reasoning effort vocabulary", () => {
  assert.equal(isReasoningEffort("low"), true);
  assert.equal(isReasoningEffort("default"), false);
  assert.equal(isReasoningEffort(3), false);
});

test("reads supported reasoning efforts from SDK model metadata", async () => {
  const capability = await getReasoningCapability("openai-native", "gpt-5.4");
  assert.deepEqual(capability.supportedEfforts, ["low", "medium", "high", "xhigh"]);
});

test("keeps omitted effort as the safe default and rejects unsupported values", async () => {
  assert.equal(await validateReasoningEffort("openai-native", "gpt-5.4", undefined), null);
  await assert.rejects(() => validateReasoningEffort("openai-native", "gpt-5.4", "max"), /not supported/);
  await assert.rejects(() => validateReasoningEffort("openai-native", "gpt-5.4", "bogus"), /one of the supported/);
});