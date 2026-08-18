import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/lib/server/redaction.ts";

test("redacts configured secrets and bearer credentials", () => {
  const previous = process.env.CONTROL_PLANE_TEST_TOKEN;
  process.env.CONTROL_PLANE_TEST_TOKEN = "unit-test-secret-value";

  try {
    const output = redactSecrets("Authorization: Bearer unit-test-secret-value");
    assert.equal(output?.includes("unit-test-secret-value"), false);
    assert.equal(output?.includes("[REDACTED"), true);
  } finally {
    if (previous === undefined) delete process.env.CONTROL_PLANE_TEST_TOKEN;
    else process.env.CONTROL_PLANE_TEST_TOKEN = previous;
  }
});

test("redacts token-shaped key/value output", () => {
  const output = redactSecrets('apiKey="visible-secret" token: visible-token');
  assert.equal(output, 'apiKey="[REDACTED_SECRET]" token: [REDACTED_SECRET]');
});