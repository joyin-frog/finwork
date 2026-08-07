import assert from "node:assert/strict";
import { createAnalyzeTabularTool } from "../lib/agent/mcp-tools/analyze-tabular.ts";

export const analyzeTabularToolTestPromise = (async () => {
  let handler: ((args: unknown) => Promise<unknown>) | undefined;
  createAnalyzeTabularTool({
    tool: (_name, _description, _schema, next) => {
      handler = next as typeof handler;
      return {};
    },
  });
  assert.ok(handler, "analyze_tabular should register");

  const result = await handler!({
    rows: [
      { department: "销售", amount: 100 },
      { department: "销售", amount: 50 },
      { department: "研发", amount: 80 },
    ],
    groupBy: ["department"],
    operations: [{ field: "amount", op: "sum" }, { field: "amount", op: "avg" }],
  });
  const text = JSON.stringify(result);
  assert.match(text, /销售/);
  assert.match(text, /150/);
  assert.match(text, /80/);

  const bad = await handler!({
    rows: [{ amount: "not-a-number" }],
    operations: [{ field: "amount", op: "sum" }],
  });
  assert.equal((bad as { isError?: boolean }).isError, true);
  console.log("analyze-tabular-tool: structured aggregation + invalid input checks passed ✓");
})();
