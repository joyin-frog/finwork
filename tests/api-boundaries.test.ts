import assert from "node:assert/strict";
import { isAllowedAppPath, isValidConversationId } from "../app/api/files/[conversationId]/[...filename]/open-with-allowlist";

export const apiBoundariesTestPromise = (async () => {
  // ── isAllowedAppPath: macOS allowlist ────────────────────────────────────
  const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });

  assert.equal(isAllowedAppPath("/Applications/Numbers.app"), true, "/Applications/ should be allowed");
  assert.equal(isAllowedAppPath("/System/Applications/Calculator.app"), true, "/System/Applications/ should be allowed");
  assert.equal(isAllowedAppPath("/tmp/evil"), false, "/tmp/evil should be blocked");
  assert.equal(isAllowedAppPath("/etc/passwd"), false, "/etc/passwd should be blocked");
  assert.equal(isAllowedAppPath("__choose__"), true, "__choose__ should be allowed (Windows dialog)");

  // ~/Applications should be allowed on macOS
  const home = process.env.HOME ?? "";
  if (home) {
    assert.equal(
      isAllowedAppPath(`${home}/Applications/Foo.app`),
      true,
      "~/Applications/ should be allowed"
    );
  }

  // Restore platform
  if (savedPlatform) {
    Object.defineProperty(process, "platform", savedPlatform);
  }

  // ── isValidConversationId ────────────────────────────────────────────────
  assert.equal(isValidConversationId("12"), true, "numeric id allowed");
  assert.equal(isValidConversationId("../../etc"), false, "traversal blocked");
  assert.equal(isValidConversationId("0"), false, "zero blocked");
  assert.equal(isValidConversationId("1e3"), false, "non-digit blocked");
  assert.equal(isValidConversationId(""), false, "empty blocked");

  console.log("api-boundaries: all checks passed ✓");
})();

apiBoundariesTestPromise.catch((err) => {
  console.error(err);
  process.exit(1);
});
