import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { getProjectRoot, getPythonPath } from "@/lib/runtime/paths";
import { pythonSpawnEnv } from "@/lib/runtime/python-env";
import { createLogger } from "@/lib/runtime/logger";
import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";
import type { FinanceToolExecutionContext } from "@/lib/agent/tools/finance-definition";

type Sdk = SdkLike;

const log = createLogger("run-python");

export function createRunPythonTool(sdk: Sdk, outputDir: string, traceId?: string) {
  // 本工具工厂每回合只创建一次，此刻 outputDir 里
  // 的文件 = 「本回合开始前」就有的产物(往次回合留下的)。把这份基线随每次 run_python 调用传给
  // worker,让防覆盖守卫只版本化这些"上一版",而本回合内新建的文件(哪怕跨多次调用)一律覆盖,
  // 不再误加 _v2。(修复:守卫原先按"每次调用前"判断,同一回合先建后存就被加 _v2。)
  const turnBeforeFiles: string[] = (() => {
    try {
      return existsSync(outputDir)
        ? readdirSync(outputDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
        : [];
    } catch {
      return [];
    }
  })();

  return sdk.tool(
    "run_python",
    [
      "Finwork 唯一的 Python 执行入口，用于读表取数、计算、数据处理和文件探查；不要用 Bash 跑 Python。",
      "正式创建或编辑 Office/PDF 文件改用对应 Skill，本工具不替代 xlsx/docx/pdf/pptx 工作流。",
      "工作目录和 output_dir 已指向本会话输出目录；不要写临时目录、输入文件旁或启动办公软件 GUI。",
      "读表一次尽量读全并紧凑输出，只打印所需值或 DataFrame，不逐格附带坐标。",
    ].join("\n"),
    { code: z.string().describe("要执行的 Python 代码") },
    (args: { code: string }, execution?: FinanceToolExecutionContext) => new Promise((resolve) => {
      if (execution?.signal?.aborted) {
        resolve({
          content: [{ type: "text" as const, text: "Python 执行已取消。" }],
          isError: true,
        });
        return;
      }
      const pythonPath = getPythonPath();
      const workerPath = path.join(getProjectRoot(), "workers", "finance_worker.py");
      // 直接用稳定的会话输出目录(不再用「每次调用新建、用完即删」的临时目录)。
      // 临时目录方案有致命缺陷:模型常把 output_dir 的值缓存下来跨多次调用复用,
      // 而每次调用的临时目录都不同且旧目录会被删除,导致最终 save 落到失效路径、产物丢失。
      mkdirSync(outputDir, { recursive: true });

      log.info("executing", {
        traceId,
        pythonPath,
        workerPath,
        outputDir,
        codeLength: args.code.length
      });

      const child = spawn(pythonPath, [workerPath, "run"], {
        // cwd 设为输出目录:即使模型用相对路径保存,也能落进可追踪目录
        cwd: outputDir,
        env: pythonSpawnEnv({
          FINANCE_AGENT_OUTPUT_DIR: outputDir,
          FINANCE_AGENT_TRACE_ID: traceId ?? "",
          // 本回合开始前已有的产物文件名(供 worker 防覆盖守卫判断"哪些算上一版");
          // 本回合内新建的不在此列 → 守卫不会给它们加 _v2,跨多次调用也覆盖同一文件。
          FINANCE_AGENT_TURN_BEFORE: JSON.stringify(turnBeforeFiles),
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.env.VIRTUAL_ENV ? { VIRTUAL_ENV: process.env.VIRTUAL_ENV } : {})
        }),
        timeout: 60_000,
        stdio: "pipe"
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let aborted = false;
      const finish = (result: unknown) => {
        if (settled) return;
        settled = true;
        execution?.signal?.removeEventListener("abort", abortChild);
        resolve(result);
      };
      const abortChild = () => {
        aborted = true;
        if (!child.killed) child.kill("SIGTERM");
      };
      execution?.signal?.addEventListener("abort", abortChild, { once: true });
      const MAX_STDOUT = 5 * 1024 * 1024;
      const MAX_STDERR = 1 * 1024 * 1024;
      // 回灌给模型的 stdout 上限。旧值 3000 太小:一次只够 ~24 行表数据,逼模型把一张表分很多次读
      // (对照 cowork 用原生 bash、输出不截,2 次就读完 282 行)。放大让 run_python 在合法读取/计算
      // 上和 bash 一样能干;前端展示另有独立的小上限(tool-call-step),不受此值影响。
      const MODEL_STDOUT_LIMIT = 24_000;

      child.stdout.on("data", (data: Buffer | string) => {
        if (stdout.length < MAX_STDOUT) stdout += data.toString("utf-8");
      });
      child.stderr.on("data", (data: Buffer | string) => {
        if (stderr.length < MAX_STDERR) stderr += data.toString("utf-8");
      });

      child.on("close", (code: number | null) => {
        if (aborted) {
          log.info("aborted", { traceId });
          finish({
            content: [{ type: "text" as const, text: "Python 执行已取消。" }],
            isError: true,
          });
          return;
        }
        if (code !== 0) {
          log.error("failed", { traceId, exitCode: code, stderr: stderr.slice(0, 500) });
          finish({
            content: [{
              type: "text" as const,
              text: `Python 执行出错 (exit code ${code}):\n${stderr.slice(0, 4000) || "(no stderr)"}\n${stdout.slice(0, 4000) || "(no stdout)"}`
            }],
            isError: true
          });
          return;
        }

        log.info("success", { traceId, stdoutLength: stdout.length });

        const stderrNote = stderr.trim() ? `\n\nstderr 警告:\n${stderr.slice(0, 4000)}` : "";

        try {
          const parsed = JSON.parse(stdout);
          // 产物已直接写在 outputDir(稳定会话目录),无需搬运;worker 的 before/after 差集只报本次新增。
          const files = (parsed.files ?? []) as Array<{ name: string; path: string; size_bytes: number; mime_type: string }>;
          const capturedStdout = typeof parsed.stdout === "string" && parsed.stdout.trim()
            ? `Python 输出:\n${parsed.stdout.trim().slice(0, MODEL_STDOUT_LIMIT)}`
            : "";
          finish({
            content: [{
              type: "text" as const,
              text: [
                files.length
                  ? `生成的文件:\n${files.map((f) => `- ${f.name} (${f.mime_type}, ${f.size_bytes} bytes)`).join("\n")}`
                  : "Python 代码执行成功，未生成新文件。",
                capturedStdout
              ].filter(Boolean).join("\n\n") + stderrNote
            }]
          });
        } catch {
          finish({
            content: [{
              type: "text" as const,
              text: `Python 输出无法解析为 JSON。原始输出:\n${stdout.slice(0, MODEL_STDOUT_LIMIT) || "(empty)"}${stderrNote}`
            }],
            isError: true
          });
        }
      });

      child.on("error", (err: Error) => {
        log.error("spawn error", { traceId, error: err });
        finish({
          content: [{ type: "text" as const, text: `无法启动 Python: ${err.message}` }],
          isError: true
        });
      });

      // Pipe the code to Python's stdin (handle potential EPIPE)
      child.stdin.on("error", (err: Error) => {
        log.error("stdin error", { traceId, error: err });
      });
      child.stdin.end(args.code);
    })
  );
}
