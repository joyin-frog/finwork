import assert from "node:assert/strict";
import { createReadGuardHook, createStuckGuardHook } from "../lib/agent/hooks/built-in.ts";

type Ctx = { toolName: string; input: unknown; outputDir: string; resolveUserQuestion?: (q: { question: string; header?: string }) => Promise<string> };
const base = (over: Partial<Ctx> & { toolName: string }): Ctx => ({ input: {}, outputDir: "/tmp/out", ...over });

(async () => {
  // ── read-guard:Office 二进制 Read/Edit/Write → deny;文本/其它工具 → allow ──
  const rg = createReadGuardHook();
  const before = (c: Ctx) => rg.before!(c as never);

  assert.equal((await before(base({ toolName: "Read", input: { file_path: "/a/b/报表.xlsx" } }))).action, "deny", "RG FAIL: Read .xlsx 应 deny");
  assert.equal((await before(base({ toolName: "Edit", input: { file_path: "/a/合同.docx" } }))).action, "deny", "RG FAIL: Edit .docx 应 deny");
  assert.equal((await before(base({ toolName: "Read", input: { file_path: "/a/data.csv" } }))).action, "allow", "RG FAIL: csv 文本应 allow(Read 能读)");
  assert.equal((await before(base({ toolName: "Read", input: { file_path: "/a/notes.txt" } }))).action, "allow", "RG FAIL: txt 应 allow");
  assert.equal((await before(base({ toolName: "Grep", input: { pattern: "x" } }))).action, "allow", "RG FAIL: 非文件工具应 allow");
  assert.equal((await before(base({ toolName: "mcp__finance_worker__run_python", input: { code: "open('x.xlsx')" } }))).action, "allow", "RG FAIL: run_python 不受 read-guard 影响");
  // deny 文案要给出正确替代工具
  const denyXlsx = await before(base({ toolName: "Read", input: { file_path: "/a/报表.xlsx" } }));
  assert.ok(denyXlsx.action === "deny" && /run_python|openpyxl/.test(denyXlsx.reason), "RG FAIL: deny 文案应导向 run_python/openpyxl");

  // ── stuck-guard:连续报错 ≥3 → 断路;成功重置;有交互通道则弹选择 ──
  const py = (over: Partial<Ctx> = {}): Ctx => base({ toolName: "mcp__finance_worker__run_python", input: { code: "x" }, ...over });
  const err = (h: ReturnType<typeof createStuckGuardHook>) => h.after!({ ...py(), result: "boom", isError: true, durationMs: 1 } as never);
  const ok = (h: ReturnType<typeof createStuckGuardHook>) => h.after!({ ...py(), result: "ok", isError: false, durationMs: 1 } as never);

  // 2 次报错还不该断
  const h1 = createStuckGuardHook();
  await err(h1); await err(h1);
  assert.equal((await h1.before!(py() as never)).action, "allow", "SG FAIL: 2 次报错不该断路");
  // 第 3 次连续报错 → 断路(无 resolver → deny 并导向 AskUserQuestion)
  await err(h1);
  const denied = await h1.before!(py() as never);
  assert.equal(denied.action, "deny", "SG FAIL: 连续 3 次报错应断路");
  assert.ok(/AskUserQuestion|说明卡点|停止重试/.test((denied as { reason: string }).reason), "SG FAIL: deny 文案应导向求助/停止");

  // 成功会重置连续报错计数
  const h2 = createStuckGuardHook();
  await err(h2); await err(h2); await ok(h2);
  assert.equal((await h2.before!(py() as never)).action, "allow", "SG FAIL: 成功应重置连续报错计数");

  // 有交互通道:回复「继续」→ allow 并重置;回复别的 → deny
  const h3 = createStuckGuardHook();
  await err(h3); await err(h3); await err(h3);
  const cont = await h3.before!(py({ resolveUserQuestion: async () => "继续" }) as never);
  assert.equal(cont.action, "allow", "SG FAIL: 用户选「继续」应放行");

  const h4 = createStuckGuardHook();
  await err(h4); await err(h4); await err(h4);
  const stop = await h4.before!(py({ resolveUserQuestion: async () => "停下" }) as never);
  assert.equal(stop.action, "deny", "SG FAIL: 用户选「停下」应断路");

  console.log("hooks-guard: all checks passed ✓");
})();
