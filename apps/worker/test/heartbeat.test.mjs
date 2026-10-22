import assert from "node:assert/strict";
import test from "node:test";
import { HEARTBEAT_ID, writeHeartbeat } from "../dist/heartbeat.js";

test("heartbeat upsert uses its stable key and supplied timestamp", async () => {
  const calls = [];
  const db = { query: async (text, values) => { calls.push({ text, values }); } };
  const timestamp = new Date("2026-10-19T14:30:00.000Z");

  await writeHeartbeat(db, timestamp);

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /ON CONFLICT \(id\) DO UPDATE/);
  assert.deepEqual(calls[0].values, [HEARTBEAT_ID, timestamp.toISOString()]);
});
