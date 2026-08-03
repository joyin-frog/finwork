import assert from "node:assert/strict";
import { createStuckGuardHook } from "../lib/agent/hooks/built-in.ts";

type Ctx = { toolName: string; input: unknown; outputDir: string; resolveUserQuestion?: (q: { question: string; header?: string }) => Promise<string> };
const base = (over: Partial<Ctx> & { toolName: string }): Ctx => ({ input: {}, outputDir: "/tmp/out", ...over });

(async () => {
  // Re-export read-guard checks stay in hooks-guard.test.ts; this file covers CR-R2 stuck policy.

  const py = (over: Partial<Ctx> = {}): Ctx => base({ toolName: "analyze_tabular", input: { code: "x" }, ...over });
  const err = (h: ReturnType<typeof createStuckGuardHook>, msg = "boom") =>
    h.after!({ ...py(), result: msg, isError: true, durationMs: 1 } as never);
  const ok = (h: ReturnType<typeof createStuckGuardHook>) =>
    h.after!({ ...py(), result: "ok", isError: false, durationMs: 1 } as never);

  // CR-R2：60 次成功 Python 不触发 stuck（无 MAX_PY）
  const hMany = createStuckGuardHook();
  for (let i = 0; i < 60; i++) await ok(hMany);
  assert.equal((await hMany.before!(py() as never)).action, "allow", "R2 FAIL: 60 次成功不应 stuck");

  // 连续同错 4 次还不该断；第 5 次后 before 断路
  const h1 = createStuckGuardHook();
  await err(h1); await err(h1); await err(h1); await err(h1);
  assert.equal((await h1.before!(py() as never)).action, "allow", "R2 FAIL: 4 次同错不该断路");
  await err(h1);
  assert.equal((await h1.before!(py() as never)).action, "deny", "R2 FAIL: 连续 5 次同错应断路");

  // 不同错误重置为 1，不累计到 5
  const h2 = createStuckGuardHook();
  await err(h2, "a"); await err(h2, "b"); await err(h2, "c"); await err(h2, "d"); await err(h2, "e");
  // 每次不同 → consecutive 始终 1 → allow
  assert.equal((await h2.before!(py() as never)).action, "allow", "R2 FAIL: 不同错误不应累计 stuck");

  console.log("run-state-recovery-ui (stuck): all checks passed ✓");
})();
