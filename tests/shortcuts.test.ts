import assert from "node:assert/strict";
import {
  SHORTCUTS,
  formatShortcut,
  isEditableTarget,
  isMacLike,
  matchesShortcut,
  resolveShortcut
} from "../app/shared/shortcuts.ts";

const evt = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false
});
const body = { tagName: "BODY", isContentEditable: false };
const textarea = { tagName: "TEXTAREA", isContentEditable: false };

function main() {
  // ── AC1: matchesShortcut 的 mod 平台映射与严格性 ──
  assert.ok(matchesShortcut(evt("n", { meta: true }), "mod+n", true), "AC1 FAIL: mac 上 mod 应映射 ⌘");
  assert.ok(!matchesShortcut(evt("n", { ctrl: true }), "mod+n", true), "AC1 FAIL: mac 上 Ctrl 不应命中 mod");
  assert.ok(matchesShortcut(evt("n", { ctrl: true }), "mod+n", false), "AC1 FAIL: win 上 mod 应映射 Ctrl");
  assert.ok(!matchesShortcut(evt("n", { meta: true }), "mod+n", false), "AC1 FAIL: win 上 Meta 不应命中 mod");
  assert.ok(!matchesShortcut(evt("n"), "mod+n", true), "AC1 FAIL: 裸 n 不应命中 mod+n");
  assert.ok(!matchesShortcut(evt("n", { meta: true, shift: true }), "mod+n", true), "AC1 FAIL: 多余 shift 不应命中");
  assert.ok(!matchesShortcut(evt("n", { meta: true, ctrl: true }), "mod+n", true), "AC1 FAIL: 双修饰不应命中");
  assert.ok(matchesShortcut(evt("N", { meta: true, shift: true }), "mod+shift+n", true), "AC1 FAIL: shift 组合应命中");
  // macOS 上 Option(⌥)+字母会把 event.key 改成特殊字符(⌥B→"∫"),必须按物理键码 event.code 命中
  assert.ok(
    matchesShortcut({ key: "∫", code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: false, altKey: true }, "mod+alt+b", true),
    "AC1 FAIL: mac ⌘⌥B 应按 code(KeyB)命中 mod+alt+b"
  );
  assert.ok(
    !matchesShortcut({ key: "b", code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, "mod+alt+b", true),
    "AC1 FAIL: 缺 alt 不应命中 mod+alt+b"
  );
  assert.ok(matchesShortcut(evt("Enter", { shift: true }), "shift+enter", true), "AC1 FAIL: shift+enter");
  assert.ok(!matchesShortcut(evt("Enter"), "shift+enter", true));
  assert.ok(matchesShortcut(evt(",", { ctrl: true }), "mod+,", false), "AC1 FAIL: mod+, 在 win");

  // ── AC2: formatShortcut 平台显示 ──
  assert.equal(formatShortcut("mod+n", true), "⌘N");
  assert.equal(formatShortcut("mod+n", false), "Ctrl+N");
  assert.equal(formatShortcut("shift+enter", true), "⇧↩");
  assert.equal(formatShortcut("shift+enter", false), "Shift+Enter");
  assert.equal(formatShortcut("mod+,", true), "⌘,");
  assert.equal(formatShortcut("mod+,", false), "Ctrl+,");
  assert.equal(formatShortcut("mod+/", true), "⌘/");
  assert.equal(formatShortcut("@", true), "@");
  assert.equal(formatShortcut("@", false), "@");
  assert.equal(formatShortcut("enter", true), "↩");
  assert.equal(formatShortcut("enter", false), "Enter");

  // ── AC3: isMacLike ──
  assert.ok(isMacLike("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"));
  assert.ok(!isMacLike("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"));
  assert.ok(!isMacLike("Mozilla/5.0 (X11; Linux x86_64)"));

  // ── AC4: 输入框守卫 ──
  assert.ok(isEditableTarget(textarea));
  assert.ok(isEditableTarget({ tagName: "INPUT", isContentEditable: false }));
  assert.ok(isEditableTarget({ tagName: "DIV", isContentEditable: true }));
  assert.ok(!isEditableTarget(body));
  // open-settings 无 allowInInput → 输入框内不触发
  assert.equal(
    resolveShortcut(evt(",", { meta: true }), textarea, { isMac: true }),
    null,
    "AC4 FAIL: 输入框内不带 allowInInput 的快捷键不得触发"
  );
  // toggle-nav allowInInput → 输入框内放行
  assert.equal(
    resolveShortcut(evt("b", { meta: true }), textarea, { isMac: true }),
    "toggle-nav",
    "AC4 FAIL: allowInInput 的快捷键在输入框内应放行"
  );
  // 裸字符在任何场景都不被全局劫持(composer 不参与全局解析)
  assert.equal(resolveShortcut(evt("/"), body, { isMac: true }), null, "AC4 FAIL: 裸 / 不得被全局监听劫持");
  assert.equal(resolveShortcut(evt("Enter"), textarea, { isMac: true }), null, "AC4 FAIL: Enter 不得被全局监听劫持");

  // ── AC5: 作用域过滤 ──
  assert.equal(
    resolveShortcut(evt("j", { meta: true }), body, { isMac: true }),
    null,
    "AC5 FAIL: chat 作用域快捷键在非 chat 页不应命中"
  );
  assert.equal(
    resolveShortcut(evt("j", { meta: true }), body, { isMac: true, scope: "chat" }),
    "toggle-file-panel",
    "AC5 FAIL: chat 页应命中 toggle-file-panel"
  );
  assert.equal(resolveShortcut(evt("n", { meta: true }), body, { isMac: true }), "new-chat");
  assert.equal(resolveShortcut(evt("/", { meta: true }), body, { isMac: true }), "show-shortcuts");
  assert.equal(resolveShortcut(evt("x", { meta: true }), body, { isMac: true }), null);

  // ── AC6: 注册表完整性 ──
  const seen = new Set<string>();
  for (const s of SHORTCUTS) {
    assert.ok(s.description.trim().length >= 2, `AC6 FAIL: ${s.id} 缺少中文说明`);
    assert.ok(/[一-鿿]/.test(s.description), `AC6 FAIL: ${s.id} 说明应为中文`);
    const key = `${s.scope === "composer" ? "composer" : "active"}:${s.combo}`;
    assert.ok(!seen.has(key), `AC6 FAIL: 组合冲突 ${key}`);
    seen.add(key);
    if (s.scope !== "composer") {
      assert.ok(s.combo.startsWith("mod+"), `AC6 FAIL: ${s.id} 全局/页面快捷键必须是 mod 系,不许劫持裸键`);
    }
    // id 唯一
    assert.equal(SHORTCUTS.filter((x) => x.id === s.id).length, 1, `AC6 FAIL: id 重复 ${s.id}`);
  }
  assert.ok(SHORTCUTS.length <= 12, "AC6 FAIL: 快捷键总数超过克制上限(12)");
  assert.ok(SHORTCUTS.some((s) => s.id === "show-shortcuts"), "AC6 FAIL: 必须有快捷键一览入口");

  console.log("shortcuts: all 6 checks passed ✓");
}

main();
