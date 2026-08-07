import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFinanceToolDefinitions } from "../../lib/agent/mcp-tools/index.ts";
import { createPiFinanceTools } from "../../lib/agent/pi/tool-adapter.ts";
import { createFinanceToolAuthorizer } from "../../lib/agent/tools/authorize.ts";

const outputDir = mkdtempSync(path.join(tmpdir(), "finwork-pi-cancel-"));
try {
  const definitions = buildFinanceToolDefinitions(outputDir);
  const tools = createPiFinanceTools(
    definitions,
    createFinanceToolAuthorizer({ outputDir }),
  );
const analyze = tools.find((tool) => tool.name === "analyze_tabular")!;
  const result = await analyze.execute(
    "pi-analyze-tabular",
    { rows: [{ department: "销售", amount: 100 }, { department: "销售", amount: 50 }], groupBy: ["department"], operations: [{ field: "amount", op: "sum" }] },
    new AbortController().signal,
    undefined,
    {} as never,
  );
  assert.match(JSON.stringify(result), /sum_amount/);
  console.log("Pi replacement ✓ analyze_tabular is structured and code-free");
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
