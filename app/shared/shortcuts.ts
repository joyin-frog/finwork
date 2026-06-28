// 快捷键注册中心 + 纯函数内核(匹配/格式化/守卫),零 DOM 依赖。
// mod = mac ⌘ / windows Ctrl。显示:mac 用符号(⌘⇧↩),windows 用文字(Ctrl+Shift+Enter)。
// composer 条目是 chat 输入框的既有行为,只入册用于展示(一览表/tooltip),不进全局监听。

export type ShortcutScope = "global" | "chat" | "composer";

export type ShortcutDef = {
  id: string;
  /** 组合语法:"mod+n" | "shift+enter" | "enter" | "@" | "/" */
  combo: string;
  description: string;
  scope: ShortcutScope;
  /** 焦点在 input/textarea 时是否仍触发(默认 false,绝不劫持打字) */
  allowInInput?: boolean;
  /** 浏览器模式可能被系统/浏览器抢占(Tauri 桌面端可用) */
  webLimited?: boolean;
};

export const SHORTCUTS: ShortcutDef[] = [
  // ── 对话输入(既有行为,仅展示) ──
  { id: "send-message",  combo: "enter",       description: "发送消息",
    scope: "composer" },
  { id: "newline",       combo: "shift+enter", description: "换行",
    scope: "composer" },
  { id: "mention-file",  combo: "@",           description: "引用对话中的文件",
    scope: "composer" },
  { id: "attach-file",   combo: "/",           description: "添加本地文件(输入框为空时)",
    scope: "composer" },
  // ── 全局 ──
  { id: "new-chat",       combo: "mod+n", description: "新对话",
    scope: "global", webLimited: true },
  { id: "toggle-nav",     combo: "mod+b", description: "收起 / 展开左侧导航",
    scope: "global", allowInInput: true },
  { id: "open-settings",  combo: "mod+,", description: "打开设置",
    scope: "global" },
  { id: "show-shortcuts", combo: "mod+/", description: "快捷键一览",
    scope: "global", allowInInput: true },
  { id: "global-search", combo: "mod+g", description: "搜索文件与对话",
    scope: "global", allowInInput: true, webLimited: true },
  // ── 对话页 ──
  { id: "toggle-file-panel", combo: "mod+j", description: "打开 / 关闭文件面板",
    scope: "chat", allowInInput: true },
  { id: "toggle-right-sidebar", combo: "mod+alt+b", description: "打开 / 关闭右侧栏",
    scope: "chat", allowInInput: true },
  { id: "find-in-chat", combo: "mod+f", description: "在对话内查找",
    scope: "chat", allowInInput: true, webLimited: true },
];

export function isMacLike(userAgent: string): boolean {
  return /Mac|iPhone|iPad/i.test(userAgent);
}

type ParsedCombo = { mod: boolean; shift: boolean; alt: boolean; key: string };

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  return {
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key
  };
}

export type ShortcutKeyEvent = {
  key: string;
  /** 物理键码(如 "KeyB"/"Digit1");用于规避 macOS Option+字母改写 event.key 的问题 */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** 字母/数字键 → 物理键码;符号/具名键返回 null(回退 event.key 比较)。 */
function keyToCode(key: string): string | null {
  if (/^[a-z]$/.test(key)) return "Key" + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return "Digit" + key;
  return null;
}

/** 严格匹配:mod 按平台映射 meta/ctrl,另一侧必须未按;shift/alt 精确。 */
export function matchesShortcut(event: ShortcutKeyEvent, combo: string, isMac: boolean): boolean {
  const parsed = parseCombo(combo);
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  const otherModPressed = isMac ? event.ctrlKey : event.metaKey;
  if (parsed.mod !== modPressed) return false;
  if (parsed.mod && otherModPressed) return false;
  if (!parsed.mod && (event.metaKey || event.ctrlKey)) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;
  // 字母/数字优先比物理键码:macOS 上 Option(⌥)会把 event.key 改成特殊字符(⌥B→"∫"),
  // 用 event.code(KeyB)才不会漏匹配;无 code 时回退到 key 比较。
  const expectedCode = keyToCode(parsed.key);
  if (expectedCode && event.code) return event.code === expectedCode;
  return event.key.toLowerCase() === parsed.key;
}

const MAC_KEY_SYMBOLS: Record<string, string> = { enter: "↩", escape: "⎋" };
const WIN_KEY_LABELS: Record<string, string> = { enter: "Enter", escape: "Esc" };

/** mac → 符号串(⌘⇧↩ / ⌘N / @);windows → 文字(Ctrl+Shift+Enter / Ctrl+N / @)。 */
export function formatShortcut(combo: string, isMac: boolean): string {
  const parsed = parseCombo(combo);
  const keyLabel = isMac
    ? MAC_KEY_SYMBOLS[parsed.key] ?? upperKey(parsed.key)
    : WIN_KEY_LABELS[parsed.key] ?? upperKey(parsed.key);

  if (isMac) {
    return `${parsed.mod ? "⌘" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${keyLabel}`;
  }
  const parts: string[] = [];
  if (parsed.mod) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(keyLabel);
  return parts.join("+");
}

function upperKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

export type ShortcutTarget = {
  tagName: string;
  isContentEditable: boolean;
};

export function isEditableTarget(target: ShortcutTarget): boolean {
  const tag = target.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * 全局监听的唯一决策内核:按作用域过滤 → 输入框守卫 → 组合匹配。
 * 命中返回 shortcut id,否则 null。composer 条目永不参与。
 */
export function resolveShortcut(
  event: ShortcutKeyEvent,
  target: ShortcutTarget,
  options: { isMac: boolean; scope?: "chat" },
  registry: ShortcutDef[] = SHORTCUTS
): string | null {
  for (const shortcut of registry) {
    if (shortcut.scope === "composer") continue;
    if (shortcut.scope === "chat" && options.scope !== "chat") continue;
    if (!shortcut.allowInInput && isEditableTarget(target)) continue;
    if (matchesShortcut(event, shortcut.combo, options.isMac)) return shortcut.id;
  }
  return null;
}

export function getShortcut(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}
