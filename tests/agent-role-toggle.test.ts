/**
 * agent-role-toggle.test.ts — v3-P2 切片先行失败测试
 *
 * 覆盖：
 * - T1  availability 行为（临时库）
 * - T2  兜底：全部 available 角色停用后 listDispatchableRoleIds 返回 available 全集（非空）
 * - T3  runner 行为（无 API key 路径）：停用角色后 runSubagent 返回 success:false + 不落行
 * - T4  toggle route 与 subagent.ts 枚举的源码接线断言
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/agent-role-toggle.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(PROJECT_ROOT, rel));
}

export const agentRoleToggleTestPromise = (async () => {

  // ─── T1：availability 行为（临时库） ──────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-toggle-t1-"));
    const dbPath = path.join(dir, "t1.db");

    const savedEnv = {
      DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
    };
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      const { getDisabledRoleIds, setRoleDisabled, listDispatchableRoleIds } =
        await import("../lib/agent/roles/availability.ts");

      // 1a：缺省 → []
      const defaultIds = getDisabledRoleIds();
      assert.ok(Array.isArray(defaultIds), "T1 FAIL: getDisabledRoleIds 应返回数组");
      assert.equal(defaultIds.length, 0, `T1 FAIL: 默认应为 []，实际 ${JSON.stringify(defaultIds)}`);

      // 1b：setRoleDisabled("tax-officer", true) 后 getDisabledRoleIds 含之
      const afterDisable = setRoleDisabled("tax-officer", true);
      assert.ok(Array.isArray(afterDisable), "T1 FAIL: setRoleDisabled 应返回新数组");
      assert.ok(
        afterDisable.includes("tax-officer"),
        `T1 FAIL: 停用后 disabled 数组应含 "tax-officer"，实际 ${JSON.stringify(afterDisable)}`
      );

      const disabledIds = getDisabledRoleIds();
      assert.ok(
        disabledIds.includes("tax-officer"),
        `T1 FAIL: getDisabledRoleIds 应含 "tax-officer"，实际 ${JSON.stringify(disabledIds)}`
      );

      // 1c：listDispatchableRoleIds 不含 tax-officer（available && !disabled）
      const dispatchable = listDispatchableRoleIds();
      assert.ok(Array.isArray(dispatchable), "T1 FAIL: listDispatchableRoleIds 应返回数组");
      assert.ok(
        !dispatchable.includes("tax-officer"),
        `T1 FAIL: 停用后 listDispatchableRoleIds 不应含 "tax-officer"，实际 ${JSON.stringify(dispatchable)}`
      );

      // 1d：audit_logs 落行（event_type / payload 断言）
      {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const row = verifyDb
          .prepare("SELECT event_type, payload FROM audit_logs WHERE event_type='agent_role_toggle' ORDER BY id DESC LIMIT 1")
          .get() as { event_type: string; payload: string } | undefined;
        verifyDb.close();

        assert.ok(row, "T1 FAIL: setRoleDisabled 后 audit_logs 应有 event_type='agent_role_toggle' 行");
        assert.equal(row!.event_type, "agent_role_toggle", `T1 FAIL: event_type 应为 'agent_role_toggle'，实际 ${row!.event_type}`);

        let payload: unknown;
        assert.doesNotThrow(() => { payload = JSON.parse(row!.payload); }, "T1 FAIL: audit_logs.payload 应为合法 JSON");
        const p = payload as Record<string, unknown>;
        assert.equal(p.roleId, "tax-officer", `T1 FAIL: payload.roleId 应为 'tax-officer'，实际 ${p.roleId}`);
        assert.equal(p.disabled, true, `T1 FAIL: payload.disabled 应为 true，实际 ${p.disabled}`);
      }

      // 1e：再 enable → getDisabledRoleIds 不含 tax-officer，listDispatchableRoleIds 恢复含之
      const afterEnable = setRoleDisabled("tax-officer", false);
      assert.ok(
        !afterEnable.includes("tax-officer"),
        `T1 FAIL: 恢复后 disabled 数组不应含 "tax-officer"，实际 ${JSON.stringify(afterEnable)}`
      );

      const disabledAfterEnable = getDisabledRoleIds();
      assert.ok(
        !disabledAfterEnable.includes("tax-officer"),
        `T1 FAIL: 恢复后 getDisabledRoleIds 不应含 "tax-officer"，实际 ${JSON.stringify(disabledAfterEnable)}`
      );

      const dispatchableAfterEnable = listDispatchableRoleIds();
      assert.ok(
        dispatchableAfterEnable.includes("tax-officer"),
        `T1 FAIL: 恢复后 listDispatchableRoleIds 应含 "tax-officer"，实际 ${JSON.stringify(dispatchableAfterEnable)}`
      );

      // 1f：对 "receivables-officer"（available:false）抛错
      assert.throws(
        () => setRoleDisabled("receivables-officer", true),
        /receivables-officer|不存在|不可用|available/,
        "T1 FAIL: 对 available:false 的角色 setRoleDisabled 应抛错"
      );

      // 1g：对 "no-such" 抛错
      assert.throws(
        () => setRoleDisabled("no-such", true),
        /no-such|不存在|未知/,
        "T1 FAIL: 对不存在的 roleId setRoleDisabled 应抛错"
      );

      console.log("agent-role-toggle T1: availability 行为 ✓");
    } finally {
      const restoreEnv = (val: string | undefined, key: string) => {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      };
      restoreEnv(savedEnv.DB_PATH, "FINANCE_AGENT_DB_PATH");
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─── T2：兜底——全部 available 角色停用后 listDispatchableRoleIds 返回 available 全集 ──
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-toggle-t2-"));
    const dbPath = path.join(dir, "t2.db");

    const savedEnv = {
      DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
    };
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      const { setRoleDisabled, listDispatchableRoleIds } =
        await import("../lib/agent/roles/availability.ts");

      const { ROLE_REGISTRY } = await import("../lib/agent/roles/registry.ts");
      const availableIds = ROLE_REGISTRY.filter((r) => r.available).map((r) => r.id);

      // 把全部 available 角色停用
      for (const roleId of availableIds) {
        setRoleDisabled(roleId, true);
      }

      // 兜底：返回 available 全集（非空）
      const fallback = listDispatchableRoleIds();
      assert.ok(Array.isArray(fallback), "T2 FAIL: 兜底时 listDispatchableRoleIds 应返回数组");
      assert.ok(
        fallback.length > 0,
        "T2 FAIL: 全部 available 角色被停用时 listDispatchableRoleIds 兜底应返回非空数组（available 全集）"
      );
      // 兜底集应等于 available 全集
      const fallbackSet = new Set(fallback);
      for (const id of availableIds) {
        assert.ok(
          fallbackSet.has(id),
          `T2 FAIL: 兜底集应包含 available 角色 "${id}"，实际 ${JSON.stringify(fallback)}`
        );
      }

      console.log("agent-role-toggle T2: 兜底（全停用→返回 available 全集）✓");
    } finally {
      const restoreEnv = (val: string | undefined, key: string) => {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      };
      restoreEnv(savedEnv.DB_PATH, "FINANCE_AGENT_DB_PATH");
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─── T3：runner 行为（无 API key 路径） ──────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-toggle-t3-"));
    const dbPath = path.join(dir, "t3.db");
    const settingsPath = path.join(dir, "settings.json");
    const secretFilePath = path.join(dir, "secret"); // 不存在 → 空 key

    const savedEnv = {
      DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
      SETTINGS_PATH: process.env.FINANCE_AGENT_SETTINGS_PATH,
      SECRET_BACKEND: process.env.FINANCE_AGENT_SECRET_BACKEND,
      SECRET_FILE: process.env.FINANCE_AGENT_SECRET_FILE,
    };

    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    process.env.FINANCE_AGENT_SETTINGS_PATH = settingsPath;
    process.env.FINANCE_AGENT_SECRET_BACKEND = "file";
    process.env.FINANCE_AGENT_SECRET_FILE = secretFilePath;

    try {
      // 重置 secret cache（确保无 key）
      const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
      _resetSecretCache();

      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // 先停用 analyst
      const { setRoleDisabled } = await import("../lib/agent/roles/availability.ts");
      setRoleDisabled("analyst", true);

      const { runSubagent } = await import("../lib/agent/subagent-runner.ts");
      const parentOutputDir = path.join(dir, "out");

      // 3a：停用 analyst 后 runSubagent 返回 success:false + content 含「已停用」
      const r1 = await runSubagent(
        { roleId: "analyst", instructions: "做个分析", label: "T3-disabled" },
        { parentOutputDir }
      );

      assert.equal(
        r1.success,
        false,
        `T3 FAIL: 停用角色后 runSubagent 应返回 success:false，实际 ${r1.success}`
      );
      assert.ok(
        r1.content.includes("已停用"),
        `T3 FAIL: 停用角色后 content 应含「已停用」，实际: ${r1.content}`
      );

      // 3b：subagent_dispatches 无新行（已停用角色不应落 dispatch 台账）
      {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const row = verifyDb
          .prepare("SELECT COUNT(*) AS n FROM subagent_dispatches WHERE role_id='analyst'")
          .get() as { n: number };
        verifyDb.close();
        assert.equal(
          row.n,
          0,
          `T3 FAIL: 停用角色调用不应在 subagent_dispatches 落行，实际行数: ${row.n}`
        );
      }

      // 3c：恢复 analyst 后同调用走到 API key 检查（content 为「Claude API Key 未配置。」）
      setRoleDisabled("analyst", false);
      _resetSecretCache();

      const r2 = await runSubagent(
        { roleId: "analyst", instructions: "做个分析", label: "T3-restored" },
        { parentOutputDir }
      );

      assert.equal(
        r2.success,
        false,
        `T3 FAIL: 恢复后无 API key 仍应 success:false，实际 ${r2.success}`
      );
      assert.ok(
        r2.content.includes("Claude API Key 未配置"),
        `T3 FAIL: 恢复后 content 应含「Claude API Key 未配置」，实际: ${r2.content}`
      );

      // 3d：恢复后落了 dispatch 行（证明走到 key 检查路径）
      {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const row = verifyDb
          .prepare("SELECT COUNT(*) AS n FROM subagent_dispatches WHERE role_id='analyst'")
          .get() as { n: number };
        verifyDb.close();
        assert.ok(
          row.n >= 1,
          `T3 FAIL: 恢复后 runSubagent 应落 dispatch 行，实际行数: ${row.n}`
        );
      }

      console.log("agent-role-toggle T3: runner 行为（停用拒绝+不落行；恢复走 key 检查）✓");
    } finally {
      const restoreEnv = (val: string | undefined, key: string) => {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      };
      restoreEnv(savedEnv.DB_PATH, "FINANCE_AGENT_DB_PATH");
      restoreEnv(savedEnv.SETTINGS_PATH, "FINANCE_AGENT_SETTINGS_PATH");
      restoreEnv(savedEnv.SECRET_BACKEND, "FINANCE_AGENT_SECRET_BACKEND");
      restoreEnv(savedEnv.SECRET_FILE, "FINANCE_AGENT_SECRET_FILE");
      try {
        const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
        _resetSecretCache();
      } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─── T4：toggle route 与 subagent.ts 枚举的源码接线断言 ───────────────────────
  {
    // 4a：POST /api/agents/toggle route 文件存在
    assert.ok(
      exists("app/api/agents/toggle/route.ts"),
      "T4 FAIL: app/api/agents/toggle/route.ts 应存在"
    );

    const toggleSrc = src("app/api/agents/toggle/route.ts");

    // 4b：import setRoleDisabled（来自 availability.ts）
    assert.ok(
      toggleSrc.includes("setRoleDisabled"),
      "T4 FAIL: toggle route 应 import/调用 setRoleDisabled"
    );

    // 4c：读取 body.roleId
    assert.ok(
      toggleSrc.includes("roleId"),
      "T4 FAIL: toggle route 应读取 body.roleId"
    );

    // 4d：读取 body.disabled
    assert.ok(
      toggleSrc.includes("disabled"),
      "T4 FAIL: toggle route 应读取 body.disabled"
    );

    // 4e：400 分支存在（非法 roleId 返回 400）
    assert.ok(
      toggleSrc.includes("400"),
      "T4 FAIL: toggle route 应有 400 错误分支（roleId 非法时）"
    );

    // 4f：export async function POST
    assert.ok(
      toggleSrc.includes("export") && toggleSrc.includes("POST"),
      "T4 FAIL: toggle route 应 export async function POST"
    );

    // 4g：返回新的 disabled 列表
    assert.ok(
      toggleSrc.includes("NextResponse") || toggleSrc.includes("Response"),
      "T4 FAIL: toggle route 应返回 NextResponse.json 或 Response"
    );

    // 4h：lib/agent/roles/availability.ts 文件存在
    assert.ok(
      exists("lib/agent/roles/availability.ts"),
      "T4 FAIL: lib/agent/roles/availability.ts 应存在"
    );

    const availSrc = src("lib/agent/roles/availability.ts");

    // 4i：导出三个契约函数
    assert.ok(
      availSrc.includes("getDisabledRoleIds"),
      "T4 FAIL: availability.ts 应导出 getDisabledRoleIds"
    );
    assert.ok(
      availSrc.includes("setRoleDisabled"),
      "T4 FAIL: availability.ts 应导出 setRoleDisabled"
    );
    assert.ok(
      availSrc.includes("listDispatchableRoleIds"),
      "T4 FAIL: availability.ts 应导出 listDispatchableRoleIds"
    );

    // 4j：读 app_settings key "agent_disabled_roles"
    assert.ok(
      availSrc.includes("agent_disabled_roles"),
      "T4 FAIL: availability.ts 应读写 app_settings key 'agent_disabled_roles'"
    );

    // 4k：写 audit_logs，event_type "agent_role_toggle"
    assert.ok(
      availSrc.includes("agent_role_toggle"),
      "T4 FAIL: availability.ts 应写 audit_logs，event_type 含 'agent_role_toggle'"
    );

    // 4l：subagent.ts 枚举改用 listDispatchableRoleIds（源码断言）
    const subagentSrc = src("lib/agent/mcp-tools/subagent.ts");
    assert.ok(
      subagentSrc.includes("listDispatchableRoleIds"),
      "T4 FAIL: lib/agent/mcp-tools/subagent.ts 的 role 枚举应改用 listDispatchableRoleIds()"
    );

    // 4m：subagent-runner.ts 停用路径存在（含「已停用」）
    const runnerSrc = src("lib/agent/subagent-runner.ts");
    assert.ok(
      runnerSrc.includes("已停用"),
      "T4 FAIL: lib/agent/subagent-runner.ts 应含角色停用拒绝逻辑（content 含「已停用」）"
    );

    // 4n：runner 停用检查在 dispatch 落行之前（停用返回不落行）——
    // 通过文件中出现顺序断言：「已停用」文案的行号 < recordDispatchStart 的行号
    {
      const lines = runnerSrc.split("\n");
      const disabledLine = lines.findIndex((l) => l.includes("已停用"));
      const dispatchLine = lines.findIndex((l) => l.includes("recordDispatchStart"));
      assert.ok(
        disabledLine !== -1,
        "T4 FAIL: runner 中找不到「已停用」文案"
      );
      assert.ok(
        dispatchLine !== -1,
        "T4 FAIL: runner 中找不到 recordDispatchStart"
      );
      assert.ok(
        disabledLine < dispatchLine,
        `T4 FAIL: 停用检查（行 ${disabledLine + 1}）应在 recordDispatchStart（行 ${dispatchLine + 1}）之前`
      );
    }

    console.log("agent-role-toggle T4: 源码接线断言 ✓");
  }

  console.log("agent-role-toggle: all T1–T4 done（上面任何 FAIL 即为红 → 等待实现者实现后才绿）");
})();
