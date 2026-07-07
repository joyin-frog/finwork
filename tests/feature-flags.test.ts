import assert from "node:assert/strict";
import { initFlags, isEnabled, allFlags } from "../lib/runtime/flags";
import { openFinanceDatabase, initializeFinanceDatabase, readFeatureFlags } from "../lib/db/sqlite";
import { afterEach, test } from "node:test";

const { ok, equal, deepEqual } = assert;

function setupDb() {
  const db = initializeFinanceDatabase(openFinanceDatabase(":memory:"));
  return db;
}

afterEach(() => {
  initFlags(); // Reset to defaults
});

test("DEFAULTS are all true", () => {
  initFlags();
  ok(isEnabled("ROUTER_ENABLED"));
  ok(isEnabled("PROMPT_CACHE_ENABLED"));
  ok(isEnabled("SESSION_LIVENESS_CHECK_ENABLED"));
  ok(isEnabled("USAGE_LIMIT_ENABLED"));
});

test("isEnabled returns false for unknown flag", () => {
  initFlags();
  equal(isEnabled("NONEXISTENT_FLAG"), false);
});

test("initFlags with overrides", () => {
  initFlags({ ROUTER_ENABLED: false });
  equal(isEnabled("ROUTER_ENABLED"), false);
  ok(isEnabled("PROMPT_CACHE_ENABLED")); // Not overridden, still default true
});

test("initFlags merges: DB overrides + unseen keep defaults", () => {
  initFlags({ ROUTER_ENABLED: false, SESSION_LIVENESS_CHECK_ENABLED: false });
  equal(isEnabled("ROUTER_ENABLED"), false);
  equal(isEnabled("SESSION_LIVENESS_CHECK_ENABLED"), false);
  ok(isEnabled("PROMPT_CACHE_ENABLED")); // Unaffected
});

test("allFlags returns a snapshot copy (not mutable reference)", () => {
  initFlags({ ROUTER_ENABLED: false });
  const snapshot = allFlags();
  snapshot.ROUTER_ENABLED = true; // Mutate copy
  equal(isEnabled("ROUTER_ENABLED"), false); // Original unaffected
});

test("readFeatureFlags from empty DB returns {}", () => {
  const db = setupDb();
  const flags = readFeatureFlags(db);
  deepEqual(flags, {});
  db.close();
});

test("readFeatureFlags reads flag: prefixed keys only", () => {
  const db = setupDb();
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("flag:ROUTER_ENABLED", "false");
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("flag:PROMPT_CACHE_ENABLED", "false");
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("other_setting", "some_value");

  const flags = readFeatureFlags(db);
  deepEqual(flags, { ROUTER_ENABLED: false, PROMPT_CACHE_ENABLED: false });
  db.close();
});

test("readFeatureFlags: non-boolean values are treated as false", () => {
  const db = setupDb();
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("flag:ROUTER_ENABLED", "false");
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("flag:SESSION_LIVENESS_CHECK_ENABLED", "not_a_bool");

  const flags = readFeatureFlags(db);
  equal(flags.ROUTER_ENABLED, false);
  equal(flags.SESSION_LIVENESS_CHECK_ENABLED, false);
  db.close();
});

test("initFlags with empty overrides preserves all defaults", () => {
  initFlags({});
  const flags = allFlags();
  equal(Object.keys(flags).length, 4);
  for (const v of Object.values(flags)) {
    equal(v, true);
  }
});
