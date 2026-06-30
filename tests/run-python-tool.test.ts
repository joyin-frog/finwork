import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// 真实集成测试:run_python 工具会 spawn workers/.venv 的 python 跑 finance_worker.py。
// 验证「spawn → 解析 worker JSON → 整形结果」这条边界,而非 worker 内部算法(后者见 python-worker.test)。
type RpResult = { content: Array<{ text: string }>; isError?: boolean };

export const runPythonToolTestPromise = (async () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "finance-agent-runpy-test-"));
  try {
    const { createRunPythonTool } = await import("../lib/agent/mcp-tools/run-python.ts");
    let handler: ((args: { code: string }) => Promise<RpResult>) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk: any = {
      tool: (_n: string, _d: string, _s: unknown, h: (args: { code: string }) => Promise<RpResult>) => {
        handler = h;
        return { name: _n };
      },
    };
    const traceId = "trace-run-python-test";
    createRunPythonTool(sdk, outputDir, traceId);
    assert.ok(handler, "run_python 应注册");

    // ── 1. 正常执行:stdout 被捕获回灌 ───────────────────────────────────
    const ok = await handler!({ code: 'print("hello-rp-123")' });
    assert.ok(!ok.isError, `正常代码不应报错: ${ok.content.map((c) => c.text).join("")}`);
    assert.ok(ok.content.map((c) => c.text).join("").includes("hello-rp-123"), "应回灌 Python stdout");

    // ── 2. 生成文件:落在 output_dir 的产物被识别 ────────────────────────
    const gen = await handler!({
      code: 'open(f"{output_dir}/产物.txt", "w", encoding="utf-8").write("data")',
    });
    assert.ok(!gen.isError, "写文件不应报错");
    assert.ok(gen.content.map((c) => c.text).join("").includes("产物.txt"), "生成的文件应出现在结果中");

    // ── 3. 运行期异常:退出码非 0 → isError,且回传错误信息 ───────────────
    const err = await handler!({ code: 'raise ValueError("boom-rp")' });
    assert.ok(err.isError, "抛异常的代码应标记 isError");
    const errorText = err.content.map((c) => c.text).join("");
    assert.ok(errorText.includes("boom-rp"), "错误信息应包含异常文案");
    assert.ok(errorText.includes(`[trace_id=${traceId}]`), "Python failure output should include the agent traceId");
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }

  console.log("run-python-tool: all 3 checks passed ✓");
})();
