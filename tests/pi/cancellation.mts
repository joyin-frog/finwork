import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  const runPython = tools.find((tool) => tool.name.endsWith("__run_python"))!;
  const controller = new AbortController();
  const startedAt = Date.now();
  const execution = runPython.execute(
    "pi-run-python-abort",
    {
      code: [
        "import time",
        "time.sleep(2)",
        "Path(output_dir, 'late-write.txt').write_text('should-not-exist')",
      ].join("\n"),
    },
    controller.signal,
    undefined,
    {} as never,
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(() => execution, /取消|aborted/i);
  assert.ok(Date.now() - startedAt < 1_500, "abort should terminate the Python worker promptly");

  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(
    existsSync(path.join(outputDir, "late-write.txt")),
    false,
    "aborted tool must stay quiescent after cancellation",
  );
  console.log("Pi cancellation ✓ AbortSignal killed run_python and 750ms stayed quiescent");
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}

