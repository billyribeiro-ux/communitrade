import assert from "node:assert/strict";
import test from "node:test";
import { isHealthResponse } from "../dist/index.js";

test("accepts Health responses described by OpenAPI", () => {
  assert.equal(isHealthResponse({ status: "ok", version: "0.1.0" }), true);
  assert.equal(isHealthResponse({ status: "not_ready", version: "0.1.0" }), true);
});

test("rejects invalid statuses, extra properties, and oversized versions", () => {
  assert.equal(isHealthResponse({ status: "down", version: "0.1.0" }), false);
  assert.equal(isHealthResponse({ status: "ok", version: "0.1.0", detail: "secret" }), false);
  assert.equal(isHealthResponse({ status: "ok", version: "x".repeat(101) }), false);
});
