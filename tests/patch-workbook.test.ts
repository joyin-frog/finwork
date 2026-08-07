/**
 * 单测:patch-workbook 的无损编辑保证。
 *
 * 存在的理由(2026-08-05 实测):openpyxl 打开一个真实工作簿再原样保存,
 * 1164 个公式缓存值全部清零。HISTORY-001 的失败链就是这么来的——模型用
 * openpyxl 改了一列,把整册缓存丢光,断言再也读不到任何数,只好求助重算;
 * 而那份工作簿的外部链接指向别人机器上的文件,谁都算不回来。
 *
 * 本命令在 XML 层只重写目标单元格,其余字节原样搬运。测试守的就是这条。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod/v4";
import { getPythonPath } from "../lib/runtime/paths.ts";
import { createPatchWorkbookTool } from "../lib/agent/mcp-tools/patch-workbook.ts";
import type { SdkLike } from "../lib/agent/mcp-tools/sdk-types.ts";

const { equal, ok, deepEqual } = assert;
const WORKER = path.join(process.cwd(), "workers", "finance_worker.py");

type PatchResult = {
  ok: boolean;
  applied: Array<{ sheet: string; cell: string }>;
  missing: Array<{ sheet: string; cell: string; reason: string }>;
  formulaCount: number;
  cachedValueCount: number;
  staleFormulas: Array<{ cell: string; formula: string }>;
  staleFormulaCount: number;
};

function patch(src: string, dst: string, edits: unknown): PatchResult {
  return JSON.parse(
    execFileSync(getPythonPath(), [WORKER, "patch-workbook", src, dst, JSON.stringify(edits)], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ) as PatchResult;
}

/** 读回 {公式数, 有缓存数, 指定格的公式/值}。 */
function inspect(file: string, probes: string[]): {
  formulaCount: number;
  cachedCount: number;
  cells: Record<string, { formula: string | null; value: string | null }>;
} {
  const script = [
    "import json,sys,openpyxl",
    "p=sys.argv[1]; probes=json.loads(sys.argv[2])",
    "f=openpyxl.load_workbook(p,data_only=False); v=openpyxl.load_workbook(p,data_only=True)",
    "tot=cached=0",
    "for sn in f.sheetnames:",
    "    for row in f[sn].iter_rows():",
    "        for c in row:",
    "            if isinstance(c.value,str) and c.value.startswith('='):",
    "                tot+=1",
    "                if v[sn][c.coordinate].value is not None: cached+=1",
    "cells={}",
    "for q in probes:",
    "    sn,ad=q.rsplit('!',1)",
    "    fv=f[sn][ad].value; vv=v[sn][ad].value",
    "    cells[q]={'formula': fv if isinstance(fv,str) and fv.startswith('=') else None,",
    "              'value': None if vv is None else str(vv)}",
    "print(json.dumps({'formulaCount':tot,'cachedCount':cached,'cells':cells},ensure_ascii=False))",
  ].join("\n");
  return JSON.parse(
    execFileSync(getPythonPath(), ["-c", script, file, JSON.stringify(probes)], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

export const patchWorkbookTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "patch-workbook-test-"));
  try {
    // 造一个「公式 + 缓存值」都齐的底稿:这正是 openpyxl 会破坏的形态。
    const seedScript = [
      "import sys,openpyxl",
      "wb=openpyxl.Workbook(); ws=wb.active; ws.title='报表'",
      "ws['A1']=10; ws['A2']=20",
      "wb.save(sys.argv[1])",
    ].join("\n");
    const seed = path.join(dir, "seed.xlsx");
    execFileSync(getPythonPath(), ["-c", seedScript, seed], { encoding: "utf-8" });

    // 用本命令注入带缓存值的公式(openpyxl 做不到「公式+缓存」并存)。
    const withCache = path.join(dir, "with-cache.xlsx");
    patch(seed, withCache, [
      { sheet: "报表", cell: "B1", formula: "=SUM(A1:A2)", value: 30 },
      { sheet: "报表", cell: "B2", formula: "=B1*2", value: 60 },
      { sheet: "报表", cell: "C1", value: "期初" },
    ]);
    const before = inspect(withCache, ["报表!B1", "报表!B2", "报表!C1"]);
    equal(before.formulaCount, 2, "底稿应有 2 条公式");
    equal(before.cachedCount, 2, "底稿两条公式都应带缓存值");
    equal(before.cells["报表!B1"]!.value, "30");
    equal(before.cells["报表!C1"]!.value, "期初", "内联字符串应可读回");

    // 1. 核心保证:改一个格子,其余缓存必须一个不少,且下游公式要跟着重算。
    //    A1: 10→99;B1=SUM(A1:A2) 应变成 119;B2=B1*2 应链式变成 238——
    //    这是依赖闭包要解决的真实问题(2026-08-06 实测 HISTORY-002:填完 TB表
    //    后,资产负债表的汇总公式缓存仍是模板旧值,读不出真实数字,模型反复
    //    摸索直到超时)。
    const patched = path.join(dir, "patched.xlsx");
    const result = patch(withCache, patched, [{ sheet: "报表", cell: "A1", value: 99 }]) as PatchResult & {
      backfilled: Array<{ sheet: string; cell: string; value: number; reason: string }>;
    };
    equal(result.ok, true);
    equal(result.applied.length, 1);
    const after = inspect(patched, ["报表!A1", "报表!B1", "报表!B2", "报表!C1"]);
    equal(after.formulaCount, before.formulaCount, "无损 FAIL: 公式数不得变化");
    equal(after.cells["报表!A1"]!.value, "99", "目标格应被改写");
    equal(after.cells["报表!B1"]!.formula, "=SUM(A1:A2)", "未触及的公式文本应原样保留");
    equal(after.cells["报表!C1"]!.value, "期初", "无关格子不该被闭包误触");

    // 2. 下游传播:B1/B2 应被自动重算为新值,标记 reason=downstream,
    //    而不再是「只列出来但不动」的旧行为。
    const downstreamB1 = result.backfilled.find((item) => item.sheet === "报表" && item.cell === "B1");
    const downstreamB2 = result.backfilled.find((item) => item.sheet === "报表" && item.cell === "B2");
    ok(downstreamB1, `下游 FAIL: B1 应被重算 —— ${JSON.stringify(result.backfilled)}`);
    equal(downstreamB1!.reason, "downstream");
    equal(Number(downstreamB1!.value), 119, "下游 FAIL: B1=SUM(99,20) 应等于 119");
    ok(downstreamB2, "下游 FAIL: B2 应通过 B1 链式重算");
    equal(Number(downstreamB2!.value), 238, "下游 FAIL: B2=B1*2 应等于 238（链式传播）");
    equal(after.cells["报表!B1"]!.value, "119.0", "读回的缓存值应是重算后的 119");
    equal(after.cells["报表!B2"]!.value, "238.0", "读回的缓存值应是重算后的 238");

    // 重算成功后,不该再出现在「未解析」清单里。
    equal(
      result.staleFormulas.some((item) => item.cell === "报表!B1" || item.cell === "报表!B2"),
      false,
      "已成功重算的格子不该再算作未解析",
    );

    // 3. 找不到工作表要如实报告,不能静默吞掉。
    const missingResult = patch(withCache, path.join(dir, "missing.xlsx"), [
      { sheet: "不存在", cell: "A1", value: 1 },
    ]);
    equal(missingResult.applied.length, 0);
    equal(missingResult.missing[0]?.reason, "sheet_not_found", "缺表 FAIL: 应如实报告");

    // 4. 引擎回填:只写公式不给值时,能算的自动补上缓存值。
    //    模型写公式不带结果是常态(HISTORY-001 两轮里 62 条全是这样),
    //    不补的话每一条都读不出数、验不了。
    const backfilled = path.join(dir, "backfilled.xlsx");
    const engineResult = patch(withCache, backfilled, [
      { sheet: "报表", cell: "D1", formula: "=A1+A2" },
      { sheet: "报表", cell: "D2", formula: "=D1*3" },
    ]) as PatchResult & {
      backfilledCount: number;
      formulaOnlyCount: number;
      unresolvedFormulaCells: string[];
      engineNote: string | null;
    };
    equal(engineResult.formulaOnlyCount, 2, "应识别出 2 条只写公式未给值");
    if (engineResult.engineNote) {
      // 引擎缺失时必须显式说明,并把这些格子列入未解析——不得静默当成成功。
      equal(engineResult.backfilledCount, 0);
      equal(engineResult.unresolvedFormulaCells.length, 2, "引擎不可用时应如实列出未解析格");
    } else {
      equal(engineResult.backfilledCount, 2, `引擎回填 FAIL: ${JSON.stringify(engineResult)}`);
      const filled = inspect(backfilled, ["报表!D1", "报表!D2"]);
      equal(filled.cells["报表!D1"]!.formula, "=A1+A2", "回填后公式必须保留");
      // 引擎回浮点(30.0),Excel 数值上等价;按数值比较,不比字符串形态。
      equal(Number(filled.cells["报表!D1"]!.value), 30, "回填 FAIL: D1 应有缓存值 30");
      equal(Number(filled.cells["报表!D2"]!.value), 90, "回填 FAIL: 依赖链上的 D2 应算出 90");
    }

    // 5. 新建 sheet:必须显式声明 createSheet,否则表名打错会被静默变成一张空表。
    const withSheet = path.join(dir, "with-sheet.xlsx");
    const created = patch(withCache, withSheet, [
      { sheet: "汇总", cell: "A1", value: "科目", createSheet: true },
      { sheet: "汇总", cell: "B1", formula: "=报表!A1+报表!A2", createSheet: true },
      { sheet: "手滑打错的表名", cell: "A1", value: 1 },
    ]) as PatchResult & { createdSheets: string[] };
    deepEqual(created.createdSheets, ["汇总"], "应只新建显式声明的表");
    equal(created.applied.length, 2);
    equal(
      created.missing[0]?.reason,
      "sheet_not_found",
      "未声明 createSheet 的未知表名必须报错，不得静默新建",
    );
    const sheetCheck = inspect(withSheet, ["汇总!A1", "汇总!B1", "报表!B1"]);
    equal(sheetCheck.cells["汇总!A1"]!.value, "科目");
    equal(Number(sheetCheck.cells["汇总!B1"]!.value), 30, "新表里的跨表公式应被引擎算出");
    equal(sheetCheck.cells["报表!B1"]!.value, "30", "新建表不得影响原有表的缓存值");

    // 6. clear 清空单元格。
    const cleared = path.join(dir, "cleared.xlsx");
    patch(withCache, cleared, [{ sheet: "报表", cell: "B2", clear: true }]);
    const afterClear = inspect(cleared, ["报表!B2"]);
    equal(afterClear.cells["报表!B2"]!.formula, null, "clear FAIL: 公式应被移除");
    equal(afterClear.cells["报表!B2"]!.value, null, "clear FAIL: 值应被移除");

    // 7. MCP 层回归:必须经过 zod schema 解析再调 handler(与生产路径
    //    tool-adapter.ts 的 `z.object(schema).parseAsync(rawArgs)` 一致)——
    //    check 5 直接调 Python worker，绕过了这层，曾经放过一个真实事故:
    //    `edit` schema 漏了 `createSheet` 字段，zod 默认 strip 未知键，模型按
    //    SKILL.md 指示传 createSheet:true 会被静默剥掉，新建 sheet 全部失败,
    //    而 check 5 因为绕过 zod 一直是绿的。
    let capturedSchema: z.ZodRawShape | undefined;
    let capturedHandler: ((args: unknown) => Promise<unknown>) | undefined;
    const captureSdk: SdkLike = {
      tool: (_name, _description, schema, handler) => {
        capturedSchema = schema;
        capturedHandler = handler;
        return undefined;
      },
    };
    createPatchWorkbookTool(captureSdk, { outputDir: dir, allowedReadRoots: [dir] });
    ok(capturedSchema && capturedHandler, "应捕获到 patch_workbook 的 schema/handler");
    const mcpOut = path.join(dir, "mcp-with-sheet.xlsx");
    const rawArgs = {
      sourcePath: withCache,
      outputName: path.basename(mcpOut),
      edits: [{ sheet: "MCP汇总", cell: "A1", value: "科目", createSheet: true }],
    };
    const parsedArgs = await z.object(capturedSchema!).parseAsync(rawArgs);
    const mcpResult = (await capturedHandler!(parsedArgs)) as { isError?: boolean; content: Array<{ text: string }> };
    ok(
      !mcpResult.isError,
      `MCP 回归 FAIL: createSheet 经 zod 解析后应仍生效 —— ${mcpResult.content?.[0]?.text}`,
    );
    ok(
      mcpResult.content[0]!.text.includes("新建工作表：MCP汇总"),
      `MCP 回归 FAIL: 未确认新表已创建 —— ${mcpResult.content[0]!.text}`,
    );

    console.log("patch-workbook: all 7 checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
