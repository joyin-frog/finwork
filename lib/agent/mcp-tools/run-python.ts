import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { getProjectRoot, getPythonPath } from "@/lib/runtime/paths";
import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

export function createRunPythonTool(sdk: Sdk, outputDir: string) {
  // 本工具工厂每回合(每次 runClaudeAgent → buildFinanceMcpServers)只创建一次,此刻 outputDir 里
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
      "执行 Python 脚本。可导入 openpyxl、pandas、matplotlib、reportlab、fpdf、python-docx、pdfplumber 等库。",
      "【工具选择】创建/改造 .xlsx/.docx/.pdf/.pptx 文档必须优先调用对应 skill(xlsx/docx/pdf/pptx),不要绕过 skill 直接用 run_python 生成正式文档。除此之外,所有 Python(读表取数、计算、数据处理、探查文件结构)都用本工具——这是跑 Python 的唯一入口。",
      "【禁用 Bash 跑 Python】严禁用 Bash 执行 Python(python -c、python - <<heredoc、python xxx.py 一律禁止);那会绕过本工具的紧凑读表与防覆盖守卫,引发一张表分多步读、_v2_v2 版本爆炸、回合超时。要跑 Python 就调本工具、把代码放进 code 参数。",
      "【读表格式】读取表格数据用紧凑格式(df.to_csv() 或只打印值),禁止逐格带 (值,坐标) 形式输出——那会让输出翻倍、逼模型分很多次才能读完一张表。",
      "【路径约束】生成的文件必须保存到 output_dir 变量指向的目录(已固定为本会话输出目录);不要自行拼接 /tmp、/var 等临时路径,否则文件会丢失、用户看不到。",
      "【openpyxl】画图时图表系列标题(series.tx)必须用 SeriesLabel 或单元格 Reference,勿直接赋字符串,否则 TypeError。"
    ].join("\n"),
    { code: z.string().describe("要执行的 Python 代码") },
    (args: { code: string }) => new Promise((resolve) => {
      const pythonPath = getPythonPath();
      const workerPath = path.join(getProjectRoot(), "workers", "finance_worker.py");
      // 直接用稳定的会话输出目录(不再用「每次调用新建、用完即删」的临时目录)。
      // 临时目录方案有致命缺陷:模型常把 output_dir 的值缓存下来跨多次调用复用,
      // 而每次调用的临时目录都不同且旧目录会被删除,导致最终 save 落到失效路径、产物丢失。
      mkdirSync(outputDir, { recursive: true });

      console.info("[run_python] executing", {
        pythonPath,
        workerPath,
        outputDir,
        codeLength: args.code.length
      });

      const child = spawn(pythonPath, [workerPath, "run"], {
        // cwd 设为输出目录:即使模型用相对路径保存,也能落进可追踪目录
        cwd: outputDir,
        env: {
          ...process.env,
          FINANCE_AGENT_OUTPUT_DIR: outputDir,
          // 本回合开始前已有的产物文件名(供 worker 防覆盖守卫判断"哪些算上一版");
          // 本回合内新建的不在此列 → 守卫不会给它们加 _v2,跨多次调用也覆盖同一文件。
          FINANCE_AGENT_TURN_BEFORE: JSON.stringify(turnBeforeFiles),
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.env.VIRTUAL_ENV ? { VIRTUAL_ENV: process.env.VIRTUAL_ENV } : {})
        },
        timeout: 60_000,
        stdio: "pipe"
      });

      let stdout = "";
      let stderr = "";
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
        if (code !== 0) {
          console.error("[run_python] failed", { exitCode: code, stderr: stderr.slice(0, 500) });
          resolve({
            content: [{
              type: "text" as const,
              text: `Python 执行出错 (exit code ${code}):\n${stderr.slice(0, 4000) || "(no stderr)"}\n${stdout.slice(0, 4000) || "(no stdout)"}`
            }],
            isError: true
          });
          return;
        }

        console.info("[run_python] success", { stdoutLength: stdout.length });

        const stderrNote = stderr.trim() ? `\n\nstderr 警告:\n${stderr.slice(0, 4000)}` : "";

        try {
          const parsed = JSON.parse(stdout);
          // 产物已直接写在 outputDir(稳定会话目录),无需搬运;worker 的 before/after 差集只报本次新增。
          const files = (parsed.files ?? []) as Array<{ name: string; path: string; size_bytes: number; mime_type: string }>;
          const capturedStdout = typeof parsed.stdout === "string" && parsed.stdout.trim()
            ? `Python 输出:\n${parsed.stdout.trim().slice(0, MODEL_STDOUT_LIMIT)}`
            : "";
          resolve({
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
          resolve({
            content: [{
              type: "text" as const,
              text: `Python 输出无法解析为 JSON。原始输出:\n${stdout.slice(0, MODEL_STDOUT_LIMIT) || "(empty)"}${stderrNote}`
            }],
            isError: true
          });
        }
      });

      child.on("error", (err: Error) => {
        console.error("[run_python] spawn error", { error: err.message });
        resolve({
          content: [{ type: "text" as const, text: `无法启动 Python: ${err.message}` }],
          isError: true
        });
      });

      // Pipe the code to Python's stdin (handle potential EPIPE)
      child.stdin.on("error", (err: Error) => {
        console.error("[run_python] stdin error", { error: err.message });
      });
      child.stdin.end(args.code);
    })
  );
}
