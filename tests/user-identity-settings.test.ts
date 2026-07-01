/**
 * 单测:用户身份(userName / userAvatar)在设置层的落库与净化。
 * 只测可观察行为(经 write→read 往返),不碰私有 normalizeAvatar:
 * - 合法小图 data URL 与用户名能持久化并读回;
 * - 头像白名单守卫:非 data:image/ 前缀、超 512KB 一律丢弃(防脏值/撑爆 settings.json);
 * - 空串表示清空。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { equal } = assert;

const SMALL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

async function main() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "user-identity-settings-test-"));
  process.env.FINANCE_AGENT_SETTINGS_PATH = path.join(tmpDir, "settings.json");

  try {
    const mod = await import("../lib/settings/claude-settings");

    // 1. 合法用户名 + 小图头像:落库后读回一致(白名单没漏字段)。
    await mod.writeClaudeSettings({ userName: "  Joyin  ", userAvatar: SMALL_PNG });
    const afterValid = await mod.readClaudeSettings();
    equal(afterValid.userName, "Joyin", "用户名应 trim 后持久化");
    equal(afterValid.userAvatar, SMALL_PNG, "合法小图头像应原样读回");

    // 2. 非图片字符串:丢弃(不写脏值,不做 XSS/任意串留存),已存的旧值被清掉。
    await mod.writeClaudeSettings({ userAvatar: "javascript:alert(1)" });
    equal((await mod.readClaudeSettings()).userAvatar, "", "非 data:image/ 前缀的头像应被丢弃");

    // 3. 超大 data URL(>512KB):丢弃,防止撑爆 settings.json。
    const huge = "data:image/png;base64," + "A".repeat(512 * 1024);
    await mod.writeClaudeSettings({ userAvatar: SMALL_PNG }); // 先放一个合法值
    await mod.writeClaudeSettings({ userAvatar: huge });
    equal((await mod.readClaudeSettings()).userAvatar, "", "超 512KB 的头像应被丢弃");

    // 4. 显式空串:清空头像。
    await mod.writeClaudeSettings({ userAvatar: SMALL_PNG });
    await mod.writeClaudeSettings({ userAvatar: "" });
    equal((await mod.readClaudeSettings()).userAvatar, "", "空串应清空头像");

    // 5. 未传头像(undefined)时保留原值,不误清空。
    await mod.writeClaudeSettings({ userAvatar: SMALL_PNG });
    await mod.writeClaudeSettings({ userName: "Alice" });
    const preserved = await mod.readClaudeSettings();
    equal(preserved.userAvatar, SMALL_PNG, "未传 userAvatar 时应保留原头像");
    equal(preserved.userName, "Alice", "用户名应更新");

    console.log("user-identity-settings tests passed");
  } finally {
    delete process.env.FINANCE_AGENT_SETTINGS_PATH;
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
  }
}

export const userIdentitySettingsTestPromise = main();
