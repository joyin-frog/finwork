import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "finwork-pi-handlers-"));
const prior = {
  appData: process.env.FINANCE_AGENT_APP_DATA_DIR,
  db: process.env.FINANCE_AGENT_DB_PATH,
};
process.env.FINANCE_AGENT_APP_DATA_DIR = root;
process.env.FINANCE_AGENT_DB_PATH = path.join(root, "handlers.db");

try {
  const { buildFinanceToolDefinitions } = await import("../../lib/agent/mcp-tools/index.ts");
  const { createPiFinanceTools } = await import("../../lib/agent/pi/tool-adapter.ts");
  const { createFinanceToolAuthorizer } = await import("../../lib/agent/tools/authorize.ts");

  const outputDir = path.join(root, "generate");
  const definitions = buildFinanceToolDefinitions(outputDir);
  const tools = createPiFinanceTools(
    definitions,
    createFinanceToolAuthorizer({
      outputDir,
      conversationId: 94001,
      resolveUserQuestion: async () => "确认",
    }),
  );
  const tool = (suffix: string) => {
    const found = tools.find((candidate) => candidate.name === suffix);
    assert.ok(found, `missing Pi tool ${suffix}`);
    return found;
  };

  await assert.rejects(
    () => tool("read_document").execute(
      "handler-read-path-deny",
      { filePath: path.join(process.cwd(), "package.json") },
      undefined,
      undefined,
      {} as never,
    ),
    /路径不在安全目录/,
  );

  const memoryResult = await tool("remember_convention").execute(
    "handler-memory",
    { text: "AR10 handler 约定仅用于隔离测试" },
    undefined,
    undefined,
    {} as never,
  );
  const memoryPath = path.join(root, "memory.md");
  assert.equal(existsSync(memoryPath), false, "governed memory must not write the legacy memory.md path");
  const memoryDetails = memoryResult.details as { candidateId?: string; candidateStatus?: string };
  assert.equal(memoryDetails.candidateStatus, "candidate");
  assert.ok(memoryDetails.candidateId, "remember_convention should return the governed candidate id");
  const { getDb } = await import("../../lib/db/sqlite.ts");
  const { GovernedMemoryStore } = await import("../../lib/memory-v2/index.ts");
  const candidate = new GovernedMemoryStore(getDb()).get(memoryDetails.candidateId!);
  assert.equal(candidate?.content.summary, "AR10 handler 约定仅用于隔离测试");
  assert.equal(candidate?.approvalStatus, "candidate");

  const voucherResult = await tool("process_voucher_batch").execute(
    "handler-voucher",
    { slips: [], mappings: [] },
    undefined,
    undefined,
    {} as never,
  );
  assert.ok(voucherResult.details, "nested voucher handler should return structured details");

  console.log("Pi handlers ✓ read_document path deny, governed remember_convention and process_voucher_batch used production handlers");
} finally {
  if (prior.appData === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
  else process.env.FINANCE_AGENT_APP_DATA_DIR = prior.appData;
  if (prior.db === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
  else process.env.FINANCE_AGENT_DB_PATH = prior.db;
  rmSync(root, { recursive: true, force: true });
}
