/**
 * 单测:设置文件信封形态的兼容与规范化。
 *
 * 真实事故(2026-08-05):磁盘上的 local-settings.json 是双层的
 * `{claude:{agent:{...}}}`,而读取器只解一层,source 停在中间层 ——
 * apiUrl / fastModel / companyName 全读成 undefined 并静默回落默认值。
 * 用户在设置页填过的东西凭空消失,界面上却没有任何报错,只会显示成"没配过"。
 *
 * 只测可观察行为(读回值 + 磁盘形态),不碰私有解包函数。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { equal, ok } = assert;

/**
 * 每个用例独立目录 + 独立模块实例,避免设置路径互相串味。
 *
 * 密钥后端强制切到临时文件:默认后端在 macOS 是系统 keychain,不隔离的话
 * readAgentSettings() 会读到**开发机上的真实 API Key**(断言失败时还会打进输出)。
 * 测试永远不该碰真实凭证。
 */
async function withSettingsFile(
  contents: unknown,
  run: (mod: typeof import("../lib/settings/agent-settings"), file: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "settings-envelope-test-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, "utf-8");
  const prev = {
    settings: process.env.FINANCE_AGENT_SETTINGS_PATH,
    backend: process.env.FINANCE_AGENT_SECRET_BACKEND,
    secret: process.env.FINANCE_AGENT_SECRET_FILE,
  };
  process.env.FINANCE_AGENT_SETTINGS_PATH = file;
  process.env.FINANCE_AGENT_SECRET_BACKEND = "file";
  process.env.FINANCE_AGENT_SECRET_FILE = path.join(dir, "local-secret");
  try {
    // 加 query 拿到全新模块实例:settings 路径在模块内经 getSettingsPath() 读取,
    // 但缓存的模块可能已持有其他用例的状态。
    const mod = await import(`../lib/settings/agent-settings?envelope=${path.basename(dir)}`);
    await run(mod as typeof import("../lib/settings/agent-settings"), file);
  } finally {
    restoreEnv("FINANCE_AGENT_SETTINGS_PATH", prev.settings);
    restoreEnv("FINANCE_AGENT_SECRET_BACKEND", prev.backend);
    restoreEnv("FINANCE_AGENT_SECRET_FILE", prev.secret);
    rmSync(dir, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function readEnvelope(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

export const settingsEnvelopeTestPromise = (async () => {
  const agentFields = {
    apiUrl: "https://gateway.example.com",
    fastModel: "model-fast",
    reasoningModel: "model-reasoning",
    companyName: "都森电子",
    agentName: "小财",
    telemetryInstallId: "fixed-install-id",
  };

  // 1. 双层信封 {claude:{agent:{...}}} —— 事故形态,修复前这里全是默认值。
  await withSettingsFile(
    { claude: { agent: agentFields, telemetryInstallId: "fixed-install-id" } },
    async (mod, file) => {
      const s = await mod.readAgentSettings();
      equal(s.apiUrl, "https://gateway.example.com", "双层信封 FAIL: apiUrl 应读出而不是回落默认值");
      equal(s.reasoningModel, "model-reasoning", "双层信封 FAIL: 推理模型应读出");
      equal(s.fastModel, "model-fast", "双层信封 FAIL: 快速模型应读出");
      equal(s.companyName, "都森电子", "双层信封 FAIL: companyName 应读出");

      // 读到非规范形态后应幂等写回单层 {agent:{...}}。
      const disk = readEnvelope(file);
      ok(!("claude" in disk), "规范化 FAIL: 磁盘上不应再有 claude 层");
      const inner = disk.agent as Record<string, unknown> | undefined;
      ok(inner && !("agent" in inner), "规范化 FAIL: agent 下不应再嵌套 agent");
      equal(inner?.reasoningModel, "model-reasoning", "规范化 FAIL: 应保留推理模型");
      equal(inner?.fastModel, "model-fast", "规范化 FAIL: 应保留快速模型");

      // 再读一次:规范化后的文件仍读出同样的值(幂等)。
      const again = await mod.readAgentSettings();
      equal(again.apiUrl, "https://gateway.example.com", "幂等 FAIL: 规范化后 apiUrl 变了");
      equal(again.reasoningModel, "model-reasoning", "幂等 FAIL: 规范化后推理模型变了");
    },
  );

  // 2. 单层 {claude:{...}} —— 旧版信封,原本就支持,不能被这次改动打破。
  await withSettingsFile({ claude: agentFields }, async (mod, file) => {
    const s = await mod.readAgentSettings();
    equal(s.apiUrl, "https://gateway.example.com", "旧信封 FAIL: apiUrl 应读出");
    equal(s.reasoningModel, "model-reasoning", "旧信封 FAIL: 推理模型应读出");
    ok(!("claude" in readEnvelope(file)), "旧信封 FAIL: 应被规范化为 agent 层");
  });

  // 3. 当前 v3 写入格式必须原样可读，且不得引起多余重写。
  const currentAgentFields = { ...agentFields };
  await withSettingsFile(
    { agent: currentAgentFields },
    async (mod, file) => {
      const before = readFileSync(file, "utf-8");
      const s = await mod.readAgentSettings();
      equal(s.apiUrl, "https://gateway.example.com", "规范形态 FAIL: apiUrl 应读出");
      equal(s.reasoningModel, "model-reasoning", "规范形态 FAIL: reasoningModel 应读出");
      equal(readFileSync(file, "utf-8"), before, "规范形态 FAIL: 已规范的文件不应被重写");
    },
  );

  // 4. 遗留明文 apiKey 在双层信封里:仍要迁进密钥库并从 JSON 抹掉。
  //    这条路径原先靠 source 指向真实对象才能 delete 掉 key,解包改了 source,必须回归。
  await withSettingsFile(
    { claude: { agent: { ...agentFields, apiKey: "sk-test-legacy-value" } } },
    async (mod, file) => {
      const s = await mod.readAgentSettings();
      equal(s.apiKey, "sk-test-legacy-value", "遗留 key FAIL: 应从 JSON 迁出并可用");
      const disk = JSON.stringify(readEnvelope(file));
      ok(!disk.includes("sk-test-legacy-value"), "遗留 key FAIL: 明文 key 必须从 JSON 抹掉");
    },
  );

  // 5. 读不动的文件绝不被写回 —— 2026-08-05 真实事故:并发读写让一次读解析失败,
  //    随后 installId 补写把整份设置覆盖成只剩一个键。读失败就必须什么都不写。
  await withSettingsFile({ agent: currentAgentFields }, async (mod, file) => {
    writeFileSync(file, '{"agent": {"apiUrl": "https://kept.example', "utf-8"); // 半写的 JSON
    const before = readFileSync(file, "utf-8");
    const s = await mod.readAgentSettings();
    equal(s.apiUrl, "https://api.anthropic.com", "读失败 FAIL: 内存里应回落默认值");
    ok(s.telemetryInstallId.length > 0, "读失败 FAIL: 内存里仍应有可用 installId");
    equal(readFileSync(file, "utf-8"), before, "读失败 FAIL: 损坏文件绝不能被写回覆盖");
  });

  // 6. 文件确实不存在时仍可按默认值创建(首启路径不能被上一条误伤)。
  await withSettingsFile({ agent: agentFields }, async (mod, file) => {
    rmSync(file);
    const s = await mod.readAgentSettings();
    ok(s.telemetryInstallId.length > 0, "首启 FAIL: 应生成 installId");
    const disk = readEnvelope(file) as { agent?: { telemetryInstallId?: string } };
    equal(disk.agent?.telemetryInstallId, s.telemetryInstallId, "首启 FAIL: installId 应落盘");
  });

  // 7. 原子写:写完不留 .tmp 残渣(rename 语义的可观察副产物)。
  await withSettingsFile({ agent: agentFields }, async (mod, file) => {
    await mod.writeAgentSettings({ companyName: "原子写测试" });
    equal((await mod.readAgentSettings()).companyName, "原子写测试", "原子写 FAIL: 值应落盘");
    const leftovers = readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"));
    equal(leftovers.length, 0, `原子写 FAIL: 残留临时文件 ${leftovers.join(", ")}`);
  });

  console.log("settings-envelope: all 7 checks passed ✓");
})();
