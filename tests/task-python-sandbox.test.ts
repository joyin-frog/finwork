import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunTaskPythonTool } from "../lib/agent/mcp-tools/run-task-python.ts";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { FileWorkspaceStore } from "../lib/file-workspace/store.ts";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: { sandbox: string; exitCode: number; createdFiles: string[]; modifiedFiles: string[]; executionId?: string };
  isError?: boolean;
};

export const taskPythonSandboxTestPromise = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-task-python-"));
  const outputDir = path.join(root, "output");
  const inputDir = path.join(root, "input");
  const outsideDir = path.join(root, "outside");
  const dbPath = path.join(root, "finance-agent.db");
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db, dbPath);
  const evidenceStore = new FileWorkspaceStore(db, path.join(root, "workspace"), Buffer.alloc(32, 9));
  fs.mkdirSync(outputDir);
  fs.mkdirSync(inputDir);
  fs.mkdirSync(outsideDir);
  const inputFile = path.join(inputDir, "source.txt");
  const victimFile = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(inputFile, "authorized-input\n", "utf8");
  fs.writeFileSync(victimFile, "do-not-read\n", "utf8");

  let handler: ((args: { scriptPath: string; args: string[]; timeoutSeconds: number }) => Promise<ToolResult>) | undefined;
  const sdk = {
    tool: (
      _name: string,
      _description: string,
      _schema: unknown,
      execute: (args: { scriptPath: string; args: string[]; timeoutSeconds: number }) => Promise<ToolResult>,
    ) => {
      handler = execute;
      return { name: _name };
    },
  };
  const dynamicReadRoots = new Set<string>();
  createRunTaskPythonTool(sdk as never, {
    outputDir,
    runId: "run-task-python-test",
    evidence: { db, store: evidenceStore },
    allowedReadRoots: () => [...dynamicReadRoots],
  });
  assert.ok(handler, "run_task_python must register its handler");
  dynamicReadRoots.add(inputDir);

  const run = async (name: string, source: string): Promise<ToolResult> => {
    fs.writeFileSync(path.join(outputDir, name), source, { encoding: "utf8", mode: 0o600 });
    return handler!({ scriptPath: name, args: [], timeoutSeconds: 20 });
  };
  const text = (result: ToolResult) => result.content.map((part) => part.text).join("\n");

  try {
    process.env.FINWORK_TASK_SANDBOX_SECRET = "must-not-leak";
    const ok = await run("normal.py", [
      "import os",
      `source = ${JSON.stringify(inputFile)}`,
      "with open(source, encoding='utf-8') as stream:",
      "    value = stream.read().strip()",
      "with open('result.txt', 'w', encoding='utf-8') as stream:",
      "    stream.write(value)",
      "print('secret-visible=' + str('FINWORK_TASK_SANDBOX_SECRET' in os.environ))",
    ].join("\n"));
    assert.equal(ok.isError, undefined, text(ok));
    assert.equal(fs.readFileSync(path.join(outputDir, "result.txt"), "utf8"), "authorized-input");
    assert.match(text(ok), /secret-visible=False/, "host secrets must not be inherited");
    assert.ok(ok.structuredContent?.createdFiles.includes("result.txt"));
    assert.ok(ok.structuredContent?.executionId, "每次脚本执行必须形成 execution 证据");
    assert.equal(
      ok.structuredContent?.sandbox,
      process.platform === "darwin"
        ? "macos-seatbelt"
        : process.platform === "win32"
          ? "windows-mxc-base-container"
          : "guarded-process",
    );

    const workbook = await run("workbook.py", [
      "import openpyxl",
      "book = openpyxl.Workbook()",
      "sheet = book.active",
      "sheet['A1'] = '受控生成'",
      "sheet['B1'] = 42",
      "book.save('generated.xlsx')",
    ].join("\n"));
    assert.equal(workbook.isError, undefined, text(workbook));
    assert.ok(fs.existsSync(path.join(outputDir, "generated.xlsx")), "Excel output must be created in output root");
    assert.ok(workbook.structuredContent?.createdFiles.includes("generated.xlsx"));

    if (process.platform === "win32") {
      const native = await run("native_stack.py", [
        "import ctypes",
        "try:",
        "    import numpy as np",
        "    print('numpy=' + str(np.arange(3).sum()))",
        "except ImportError:",
        "    print('numpy=not-installed')",
        `target = ${JSON.stringify(path.join(outsideDir, "native-bypass.txt"))}`,
        "handle = ctypes.windll.kernel32.CreateFileW(target, 0x40000000, 0, None, 2, 0x80, None)",
        "print('native-write-blocked=' + str(handle == -1 or handle == 0xFFFFFFFF))",
      ].join("\n"));
      assert.equal(native.isError, undefined, text(native));
      assert.match(text(native), /native-write-blocked=True/, "BaseContainer must block ctypes filesystem bypass");
      assert.ok(!fs.existsSync(path.join(outsideDir, "native-bypass.txt")));
    }

    const deniedRead = await run("deny_read.py", `print(open(${JSON.stringify(victimFile)}).read())\n`);
    assert.equal(deniedRead.isError, true, "reading outside task roots must fail");
    assert.match(text(deniedRead), /denied file read|Operation not permitted/);

    const planted = path.join(outsideDir, "planted.txt");
    const deniedWrite = await run("deny_write.py", `open(${JSON.stringify(planted)}, 'w').write('bad')\n`);
    assert.equal(deniedWrite.isError, true, "writing outside output root must fail");
    assert.ok(!fs.existsSync(planted), "sandbox must not create an outside file");

    const deniedNetwork = await run("deny_network.py", "import socket\nsocket.socket()\n");
    assert.equal(deniedNetwork.isError, true, "network APIs must fail");
    assert.match(text(deniedNetwork), /denied/);

    const deniedProcess = await run("deny_process.py", "import subprocess\nsubprocess.run(['echo', 'bad'])\n");
    assert.equal(deniedProcess.isError, true, "child processes must fail");
    assert.match(text(deniedProcess), /denied/);

    const quota = await run("deny_quota.py", [
      "import os",
      "os.mkdir('many-files')",
      "for index in range(2001):",
      "    open(f'many-files/{index}.txt', 'w').close()",
    ].join("\n"));
    assert.equal(quota.isError, true, "file-count quota must fail closed");
    assert.match(text(quota), /任务配额/);

    const absolute = await handler!({ scriptPath: victimFile, args: [], timeoutSeconds: 20 });
    assert.equal(absolute.isError, true, "absolute script paths must be rejected");

    const executions = db.prepare(`
      SELECT status,script_version_id,input_refs_json,output_manifest_json
      FROM script_executions WHERE run_id=? ORDER BY started_at
    `).all("run-task-python-test") as Array<{
      status: string;
      script_version_id: string;
      input_refs_json: string;
      output_manifest_json: string;
    }>;
    assert.ok(executions.length >= 6, "成功和失败的执行都必须留痕");
    assert.ok(executions.every((row) => row.status !== "running"), "执行结束后不得残留 running 记录");
    assert.ok(executions.some((row) => JSON.parse(row.output_manifest_json).some((item: { logicalPath: string }) => item.logicalPath === "generated.xlsx")));
    const births = db.prepare(`
      SELECT base_version_id,validation_json FROM file_changesets WHERE run_id=?
    `).all("run-task-python-test") as Array<{ base_version_id: string | null; validation_json: string }>;
    assert.ok(births.some((row) => row.base_version_id === null && JSON.parse(row.validation_json).kind === "generated_output_birth"));
  } finally {
    delete process.env.FINWORK_TASK_SANDBOX_SECRET;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("task-python-sandbox: scoped reads/writes, no network/process/env leak ✓");
})();
