import assert from "node:assert/strict";
import test from "node:test";
import { AppConfigError, parseAppConfig } from "../dist/index.js";

test("parses a valid config and applies the local API port default", () => {
  assert.deepEqual(parseAppConfig({ DATABASE_URL: "postgresql://user:secret@localhost:5432/app" }), {
    port: 3001,
    databaseUrl: "postgresql://user:secret@localhost:5432/app",
  });
});

test("rejects invalid ports without echoing supplied values", () => {
  assert.throws(() => parseAppConfig({ PORT: "70000", DATABASE_URL: "postgres://localhost/app" }), (error) => {
    assert.ok(error instanceof AppConfigError);
    assert.equal(error.message.includes("70000"), false);
    return true;
  });
});

test("rejects missing and non-PostgreSQL database URLs without revealing credentials", () => {
  assert.throws(() => parseAppConfig({}), /DATABASE_URL is required/);
  assert.throws(() => parseAppConfig({ DATABASE_URL: "mysql://alice:secret@db.example/app" }), (error) => {
    assert.ok(error instanceof AppConfigError);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});
