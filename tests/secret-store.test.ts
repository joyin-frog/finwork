import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// #2 回归:API Key 必须存进 secret store,绝不明文落 settings.json;旧明文 key 自动迁移。
// 用 file 后端跑(跨平台、不碰真实钥匙串,CI 可用)。
export const secretStoreTestPromise = (async () => {
  const { ok, equal } = assert;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fa-secret-"));
  const secretFile = path.join(dir, "secret");
  const settingsFile = path.join(dir, "local-settings.json");
  process.env.FINANCE_AGENT_SECRET_BACKEND = "file";
  process.env.FINANCE_AGENT_SECRET_FILE = secretFile;
  process.env.FINANCE_AGENT_SETTINGS_PATH = settingsFile;

  try {
    const { writeClaudeSettings, readClaudeSettings } = await import("../lib/settings/claude-settings");
    const { getApiKeySecret, setApiKeySecret, _resetSecretCache } = await import("../lib/settings/secret-store");

    // ── T1: 写入后 settings.json 不含明文 key ───────────────────────
    _resetSecretCache();
    await writeClaudeSettings({ apiUrl: "https://gw.example.com", apiKey: "sk-secret-123", model: "claude-x" });
    const rawJson = await fs.readFile(settingsFile, "utf-8");
    ok(!rawJson.includes("sk-secret-123"), "T1 FAIL: settings.json 不应含明文 apiKey");
    const parsed = JSON.parse(rawJson);
    ok(!parsed.claude.apiKey, "T1 FAIL: JSON 不应保留 apiKey 字段");
    equal(parsed.claude.apiUrl, "https://gw.example.com", "T1 FAIL: 非密钥字段应正常持久化");
    equal((await fs.readFile(secretFile, "utf-8")).trim(), "sk-secret-123", "T1 FAIL: key 应进 secret store");

    // ── T2: 读回拿到 key(来自 secret store) ───────────────────────
    _resetSecretCache();
    const s = await readClaudeSettings();
    equal(s.apiKey, "sk-secret-123", "T2 FAIL: 应从 secret store 读回 key");
    equal(s.apiUrl, "https://gw.example.com", "T2 FAIL: 非密钥字段应读回");

    // ── T3: 旧版明文 key 迁移(JSON 里有 key、store 为空) ──────────
    _resetSecretCache();
    await fs.rm(secretFile, { force: true });
    await fs.writeFile(
      settingsFile,
      `${JSON.stringify({ claude: { apiUrl: "https://legacy", apiKey: "sk-legacy-999", model: "m" } }, null, 2)}\n`,
      "utf-8",
    );
    const migrated = await readClaudeSettings();
    equal(migrated.apiKey, "sk-legacy-999", "T3 FAIL: 应读出旧明文 key");
    const afterJson = await fs.readFile(settingsFile, "utf-8");
    ok(!afterJson.includes("sk-legacy-999"), "T3 FAIL: 迁移后 JSON 不应再含明文 key");
    equal((await fs.readFile(secretFile, "utf-8")).trim(), "sk-legacy-999", "T3 FAIL: 旧 key 应迁入 secret store");

    // ── T4: 清空 key ──────────────────────────────────────────────
    _resetSecretCache();
    await writeClaudeSettings({ apiKey: "" });
    _resetSecretCache();
    const cleared = await readClaudeSettings();
    equal(cleared.apiKey, "", "T4 FAIL: 清空后 key 应为空");
    const stillThere = await fs.access(secretFile).then(() => true).catch(() => false);
    ok(!stillThere, "T4 FAIL: 清空后 secret 文件应删除");

    // ── T5: 进程内缓存——写入后两次读取均命中缓存 ──────────────────
    _resetSecretCache();
    await setApiKeySecret("k1");
    const read1 = await getApiKeySecret();
    const read2 = await getApiKeySecret();
    equal(read1, "k1", "T5 FAIL: 第一次读应返回 k1");
    equal(read2, "k1", "T5 FAIL: 第二次读应命中缓存返回 k1");

    // ── T6: 后端写入失败时 setApiKeySecret 返回 false,不抛异常 ─────
    _resetSecretCache();
    // 把 secret 文件路径指向已存在的目录,fileSet 写文件时必然报 EISDIR
    process.env.FINANCE_AGENT_SECRET_FILE = dir; // dir 是目录,不是文件
    let setResult: boolean | undefined;
    let threw = false;
    try {
      setResult = await setApiKeySecret("x");
    } catch {
      threw = true;
    }
    ok(!threw, "T6 FAIL: setApiKeySecret 不应抛出异常");
    equal(setResult, false, "T6 FAIL: 后端写入失败应返回 false");
    // 恢复 secretFile 路径
    process.env.FINANCE_AGENT_SECRET_FILE = secretFile;

    console.log("secret-store tests passed");
  } finally {
    delete process.env.FINANCE_AGENT_SECRET_BACKEND;
    delete process.env.FINANCE_AGENT_SECRET_FILE;
    delete process.env.FINANCE_AGENT_SETTINGS_PATH;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
})();
