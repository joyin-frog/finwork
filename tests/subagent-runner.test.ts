/**
 * subagent-runner 编排逻辑测试
 *
 * 运行（必须先红，等实现 roleId 改造后才绿）：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/subagent-runner.test.ts
 *
 * 不依赖网络：把 apiKey 强制清空（file 后端 + 空密钥文件 + 空 settings），
 * runSubagent 走「API Key 未配置」早返回分支，从而可确定性地测编排逻辑
 * （标签保留、每任务一个结果、Semaphore 不死锁、allSettled 映射、输出目录创建）。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

export const subagentRunnerTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-subagent-test-"));
  const saved = {
    backend: process.env.FINANCE_AGENT_SECRET_BACKEND,
    secretFile: process.env.FINANCE_AGENT_SECRET_FILE,
    settings: process.env.FINANCE_AGENT_SETTINGS_PATH,
  };
  process.env.FINANCE_AGENT_SECRET_BACKEND = "file";
  process.env.FINANCE_AGENT_SECRET_FILE = path.join(dir, "secret"); // 不存在 → 空 key
  process.env.FINANCE_AGENT_SETTINGS_PATH = path.join(dir, "settings.json");

  try {
    const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
    _resetSecretCache(); // 清掉别的测试可能缓存的真实 key
    const { runSubagent, runSubagentsParallel } = await import("../lib/agent/subagent-runner.ts");

    const parentOutputDir = path.join(dir, "out");

    // ── 1. 单任务:无 key 时早返回失败,但标签/结构完整、输出目录已建 ─────
    const r = await runSubagent(
      { roleId: "analyst", instructions: "做点分析", label: "报表 任务" },
      { parentOutputDir }
    );
    assert.equal(r.success, false, "无 API Key 应返回失败");
    assert.equal(r.content, "Claude API Key 未配置。", "应给出未配置文案");
    assert.equal(r.label, "报表 任务", "应原样保留传入 label(含中文/空格)");
    assert.ok(r.durationMs >= 0, "durationMs 应被记录");
    const subagentsDir = path.join(parentOutputDir, "subagents");
    assert.ok(existsSync(subagentsDir), "应创建 subagents 输出目录");
    assert.ok(
      readdirSync(subagentsDir).some((n) => /^_+_\d+$/.test(n) || n.includes("_")),
      "子目录名应基于 label 做安全化(非字母数字替换为 _)"
    );

    // ── 2. 并行编排:N 个任务 → N 个结果,按序对应,均完成不死锁 ──────────
    const tasks = [
      { roleId: "payroll-officer", instructions: "算薪 A", label: "A" },
      { roleId: "bookkeeper",      instructions: "报销 B", label: "B" },
      { roleId: "bookkeeper",      instructions: "金蝶 C", label: "C" },
    ];
    const results = await runSubagentsParallel(tasks, { parentOutputDir, concurrency: 2 });
    assert.equal(results.length, 3, "应每个任务一个结果");
    assert.deepEqual(results.map((x) => x.label), ["A", "B", "C"], "结果顺序应与输入任务一一对应");
    assert.ok(results.every((x) => x.success === false), "无 key 时每个子任务都失败(但不抛)");

    // ── 3. 空任务列表:返回空数组,不挂起 ────────────────────────────────
    const empty = await runSubagentsParallel([], { parentOutputDir });
    assert.deepEqual(empty, [], "空任务列表应返回空数组");

    // ── 4. 未知 roleId：success:false 且不抛异常，content 含提示信息 ────
    const unknownResult = await runSubagent(
      { roleId: "no-such-role", instructions: "随便做点事", label: "未知角色测试" },
      { parentOutputDir }
    );
    assert.equal(
      unknownResult.success,
      false,
      "未知 roleId 应返回 success:false，不抛异常"
    );
    // content 应包含「未知角色」提示或 roleId 本身，便于调用方排查
    const hasHint =
      unknownResult.content.includes("未知角色") ||
      unknownResult.content.includes("no-such-role");
    assert.ok(
      hasHint,
      `未知 roleId 的 content 应含"未知角色"或 roleId，实际: "${unknownResult.content}"`
    );
  } finally {
    const restore = (k: keyof typeof saved, name: string) => {
      if (saved[k] === undefined) delete process.env[name];
      else process.env[name] = saved[k]!;
    };
    restore("backend", "FINANCE_AGENT_SECRET_BACKEND");
    restore("secretFile", "FINANCE_AGENT_SECRET_FILE");
    restore("settings", "FINANCE_AGENT_SETTINGS_PATH");
    try {
      const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
      _resetSecretCache();
    } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("subagent-runner: all 4 checks passed ✓");
})();
