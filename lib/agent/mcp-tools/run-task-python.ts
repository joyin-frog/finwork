import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod/v4";
import { wrapCommandWithSandbox } from "@/lib/agent/tools/bash-sandbox";
import {
  createSandboxProcessEnvironment,
  mxcBrokerEnvironment,
  requireWindowsMxcBaseContainer,
  sandboxPlatform,
  windowsMxcExecutablePath,
} from "@/lib/agent/tools/process-sandbox";
import { getDb } from "@/lib/db/sqlite";
import {
  beginScriptExecution,
  finishScriptExecution,
  getFileWorkspaceStore,
  recordGeneratedOutputVersion,
  recordScriptRevision,
  type FileWorkspaceStore,
  type GeneratedOutputEvidence,
} from "@/lib/file-workspace";
import { getProjectRoot, getPythonBinDir, getPythonPath, getPythonVenvRoot } from "@/lib/runtime/paths";
import type { SdkLike } from "./sdk-types";
import type { ContainerConfig, SandboxPolicy } from "@microsoft/mxc-sdk";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_GENERATED_BYTES = 512 * 1024 * 1024;

export function createRunTaskPythonTool(
  sdk: SdkLike,
  options: {
    outputDir: string;
    allowedReadRoots: string[] | (() => string[]);
    runId?: string;
    evidence?: { db: DatabaseSync; store: FileWorkspaceStore };
  },
) {
  return sdk.tool(
    "run_task_python",
    [
      "运行本回合输出目录中的 Python 脚本。用于通用工具无法表达的特殊清洗、计算和文件生成。",
      "脚本只能读取任务输入快照和运行时，只能写本回合输出目录，默认无网络、不能启动子进程。",
      "可反复 edit 脚本并调用本工具；修改既有工作簿时优先输出结构化 edits JSON，再交给 patch_workspace_workbook，版本、diff 和复核由 Harness 自动完成。",
    ].join("\n"),
    {
      scriptPath: z.string().min(1).describe("输出目录内的 .py 脚本相对路径"),
      args: z.array(z.string().max(2_000)).max(100).default([]),
      timeoutSeconds: z.number().int().min(1).max(180).default(90),
    },
    async (args: { scriptPath: string; args: string[]; timeoutSeconds: number }) => {
      let executionId: string | undefined;
      let completedExecutionId: string | undefined;
      try {
        const outputRoot = canonicalDirectory(options.outputDir);
        const script = resolveRegularOutputFile(outputRoot, args.scriptPath);
        if (path.extname(script).toLowerCase() !== ".py") return toolError("run_task_python 只运行 .py 脚本");
        const scriptLogicalPath = path.relative(outputRoot, script);
        const evidence = options.runId
          ? {
              db: options.evidence?.db ?? getDb(),
              store: options.evidence?.store ?? await getFileWorkspaceStore(),
              runId: options.runId,
            }
          : null;
        let scriptEvidence: Awaited<ReturnType<typeof recordScriptRevision>> | undefined;
        if (evidence) {
          scriptEvidence = await recordScriptRevision({
            ...evidence,
            scriptPath: script,
            logicalPath: scriptLogicalPath,
          });
          executionId = beginScriptExecution({
            db: evidence.db,
            runId: evidence.runId,
            script: scriptEvidence,
            sandboxKind: sandboxPlatform(),
            args: args.args,
          }).executionId;
        }
        const runner = path.join(getProjectRoot(), "workers", "task_python_runner.py");
        const before = snapshotFiles(outputRoot);
        const baselineUsage = measureOutputUsage(outputRoot);
        const allowedReadRoots = typeof options.allowedReadRoots === "function"
          ? options.allowedReadRoots()
          : options.allowedReadRoots;
        const policy = Buffer.from(JSON.stringify({
          writeRoot: outputRoot,
          readRoots: allowedReadRoots.map(canonicalExisting).filter(Boolean),
        }), "utf8").toString("base64url");
        const configuredPython = getPythonPath();
        const python = canonicalExisting(configuredPython) || configuredPython;
        const pythonBinDir = getPythonBinDir();
        const pythonVenvRoot = getPythonVenvRoot();
        const pythonRuntimeRoot = pythonVenvRoot ?? (
          process.platform === "win32"
            ? path.dirname(python)
            : path.dirname(path.dirname(python))
        );
        const env = createSandboxProcessEnvironment({
          writeRoot: outputRoot,
          executableDirs: [pythonBinDir],
          extra: {
            ...(pythonVenvRoot ? { VIRTUAL_ENV: pythonVenvRoot } : {}),
            ...(process.platform === "win32" ? { FINWORK_OS_SANDBOX: "windows-mxc-base-container" } : {}),
          },
        });
        const commandArgs = [runner, policy, script, ...args.args];
        let result: Awaited<ReturnType<typeof runSandboxedPython>>;
        try {
          result = await runSandboxedPython({
            python,
            args: commandArgs,
            cwd: outputRoot,
            env,
            timeoutMs: args.timeoutSeconds * 1_000,
            outputRoot,
            baselineUsage,
            readRoots: [
              ...allowedReadRoots,
              runner,
            ],
            runtimeRoots: [pythonRuntimeRoot],
          });
        } catch (error) {
          if (executionId && evidence) {
            finishScriptExecution({
              db: evidence.db,
              executionId,
              error: error instanceof Error ? error.message : String(error),
            });
            executionId = undefined;
          }
          throw error;
        }
        const after = snapshotFiles(outputRoot);
        const files = diffSnapshots(before, after);
        const outputEvidence: GeneratedOutputEvidence[] = [];
        if (evidence) {
          for (const logicalPath of [...files.created, ...files.modified]) {
            if (!isGeneratedEvidenceCandidate(logicalPath, scriptLogicalPath)) continue;
            outputEvidence.push(await recordGeneratedOutputVersion({
              ...evidence,
              filePath: path.join(outputRoot, logicalPath),
              logicalPath,
              source: "script_execution",
            }));
          }
        }
        if (executionId && evidence) {
          completedExecutionId = executionId;
          finishScriptExecution({
            db: evidence.db,
            executionId,
            exitCode: result.exitCode,
            outputs: outputEvidence,
          });
          executionId = undefined;
        }
        const summary = [
          `Python 脚本执行${result.exitCode === 0 ? "完成" : "失败"}（${sandboxPlatform()}，exit=${result.exitCode}）。`,
          files.created.length || files.modified.length
            ? `新增 ${files.created.length} 个文件，修改 ${files.modified.length} 个文件。`
            : "没有检测到输出文件变化。",
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            kind: "task_python_result",
            sandbox: sandboxPlatform(),
            exitCode: result.exitCode,
            createdFiles: files.created,
            modifiedFiles: files.modified,
            executionId: completedExecutionId,
            scriptVersionId: scriptEvidence?.versionId,
            outputEvidence,
          },
          ...(result.exitCode === 0 ? {} : { isError: true as const }),
        };
      } catch (error) {
        if (executionId) {
          try {
            finishScriptExecution({
              db: getDb(),
              executionId,
              error: error instanceof Error ? error.message : String(error),
            });
          } catch { /* preserve original execution error */ }
        }
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  );
}

async function runSandboxedPython(input: {
  python: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputRoot: string;
  baselineUsage: OutputUsage;
  readRoots: string[];
  runtimeRoots: string[];
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const macos = process.platform === "darwin";
  const windows = process.platform === "win32";
  const command = macos
    ? wrapCommandWithSandbox(
        [input.python, ...input.args].map(shellQuote).join(" "),
        {
          readRoot: input.cwd,
          readRoots: [...input.readRoots, ...input.runtimeRoots],
          writeRoot: input.cwd,
        },
      )
    : null;
  const mxc = windows ? windowsMxcExecutablePath(getProjectRoot()) : null;
  if (windows && !mxc) {
    throw new Error("Microsoft MXC 执行器不可用；生产包不允许降级为普通 Python 进程");
  }
  if (windows) requireWindowsMxcBaseContainer(mxc!);
  const windowsConfig = windows ? await buildWindowsMxcConfig(input) : null;
  const child = macos
    ? spawn("/bin/sh", ["-c", command!], { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] })
    : windows
      ? spawn(mxc!, [
          "--config-base64",
          Buffer.from(JSON.stringify(windowsConfig), "utf8").toString("base64"),
          "--experimental",
        ], {
          cwd: input.cwd,
          env: mxcBrokerEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(input.python, input.args, { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  let quotaError = "";
  const stopOnOverflow = () => {
    if (!overflow) return;
    child.kill("SIGKILL");
  };
  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
      overflow = true;
      return next.slice(0, MAX_OUTPUT_BYTES);
    }
    return next;
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); stopOnOverflow(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); stopOnOverflow(); });
  return new Promise((resolve, reject) => {
    // The native Windows broker owns the authoritative wall-clock timer and
    // closes its KILL_ON_JOB_CLOSE job on death. This outer timer only guards
    // a wedged broker and deliberately gives it a small cleanup grace period.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Python 脚本超过 ${Math.ceil(input.timeoutMs / 1_000)} 秒，已终止`));
    }, input.timeoutMs + (windows ? 5_000 : 0));
    const checkQuota = () => {
      try {
        const usage = measureOutputUsage(input.outputRoot);
        const addedFiles = Math.max(0, usage.files - input.baselineUsage.files);
        const addedBytes = Math.max(0, usage.bytes - input.baselineUsage.bytes);
        if (addedFiles > MAX_FILES || addedBytes > MAX_GENERATED_BYTES) {
          quotaError = `Python 输出超过任务配额（新增文件 ${addedFiles}/${MAX_FILES}，新增字节 ${addedBytes}/${MAX_GENERATED_BYTES}）`;
          child.kill("SIGKILL");
        }
      } catch (error) {
        quotaError = `无法核验 Python 输出配额：${error instanceof Error ? error.message : String(error)}`;
        child.kill("SIGKILL");
      }
    };
    const quotaTimer = setInterval(checkQuota, 250);
    quotaTimer.unref();
    child.on("error", (error) => { clearTimeout(timer); clearInterval(quotaTimer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(quotaTimer);
      checkQuota();
      if (quotaError) return reject(new Error(quotaError));
      if (overflow) return reject(new Error(`Python 输出超过 ${MAX_OUTPUT_BYTES} 字节，已终止记录`));
      resolve({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** @internal exported for deterministic policy-contract tests. */
export function buildWindowsMxcPolicy(input: {
  python: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  readRoots: string[];
  runtimeRoots: string[];
}): SandboxPolicy {
  const readonlyPaths = [...new Set([...input.readRoots, ...input.runtimeRoots])]
    .filter((item) => path.resolve(item) !== path.resolve(input.cwd));
  return {
    version: "0.7.0-alpha",
    filesystem: {
      readwritePaths: [input.cwd],
      readonlyPaths,
      deniedPaths: [],
      clearPolicyOnExit: true,
    },
    network: {
      allowOutbound: false,
      allowLocalNetwork: false,
    },
    ui: {
      allowWindows: false,
      clipboard: "none",
      allowInputInjection: false,
    },
    timeoutMs: input.timeoutMs,
  };
}

async function buildWindowsMxcConfig(input: {
  python: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  readRoots: string[];
  runtimeRoots: string[];
}): Promise<ContainerConfig> {
  // 只通过 MXC SDK 的公开 policy→config 映射构造 wire payload，避免应用
  // 自行猜测 ProcessContainer/BaseContainer 字段。--experimental 仍由调用方
  // 显式提供，使 processcontainer 在 probe=base-container 时选择新边界。
  const { createConfigFromPolicy } = await import("@microsoft/mxc-sdk");
  const config = createConfigFromPolicy(
    buildWindowsMxcPolicy(input),
    "process",
    `Finwork-TaskPython-${randomUUID()}`,
  );
  config.process = {
    ...(config.process ?? { commandLine: "" }),
    commandLine: [input.python, ...input.args].map(windowsQuoteArg).join(" "),
    cwd: input.cwd,
    env: Object.entries(input.env)
      .filter((entry): entry is [string, string] => entry[1] != null)
      .map(([key, value]) => `${key}=${value}`),
    timeout: input.timeoutMs,
  };
  return config;
}

function windowsQuoteArg(value: string): string {
  if (value.length > 32_000 || value.includes("\0")) throw new Error("Windows 沙箱参数无效");
  if (value && !/[\s"]/.test(value)) return value;
  let output = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
    } else if (character === '"') {
      output += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      output += "\\".repeat(slashes) + character;
      slashes = 0;
    }
  }
  return output + "\\".repeat(slashes * 2) + '"';
}

type FileSnapshot = Map<string, string>;
type OutputUsage = { files: number; bytes: number };

function measureOutputUsage(root: string): OutputUsage {
  let files = 0;
  let bytes = 0;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".sandbox-") || entry.name === ".finwork-review" || entry.name === "delivered") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        files += 1;
        bytes += stat.size;
      }
    }
  };
  visit(root);
  return { files, bytes };
}

function snapshotFiles(root: string): FileSnapshot {
  const snapshot = new Map<string, string>();
  const visit = (dir: string) => {
    if (snapshot.size >= MAX_FILES) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".sandbox-") || entry.name === ".finwork-review" || entry.name === "delivered") continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        snapshot.set(relative, `${stat.size}:${stat.mtimeMs}:${digestPrefix(absolute, stat.size)}`);
      }
    }
  };
  visit(root);
  return snapshot;
}

function diffSnapshots(before: FileSnapshot, after: FileSnapshot) {
  const created: string[] = [];
  const modified: string[] = [];
  for (const [name, fingerprint] of after) {
    if (!before.has(name)) created.push(name);
    else if (before.get(name) !== fingerprint) modified.push(name);
  }
  return { created, modified };
}

function isGeneratedEvidenceCandidate(logicalPath: string, scriptLogicalPath: string): boolean {
  const normalized = logicalPath.split(path.sep).join("/");
  if (normalized === scriptLogicalPath.split(path.sep).join("/")) return false;
  return !normalized.split("/").some((part) => part.startsWith(".sandbox-") || part.startsWith(".finwork-"));
}

function digestPrefix(filePath: string, size: number): string {
  if (size > 8 * 1024 * 1024) return "large";
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16);
}

function canonicalDirectory(value: string): string {
  const resolved = fs.realpathSync.native(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("任务输出目录不可用");
  return resolved;
}

function canonicalExisting(value: string): string {
  try { return fs.realpathSync.native(value); }
  catch { return ""; }
}

function resolveRegularOutputFile(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error("scriptPath 只接受输出目录内的相对路径");
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new Error("scriptPath 越过输出目录");
  const link = fs.lstatSync(candidate);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error("scriptPath 必须是普通文件");
  const real = fs.realpathSync.native(candidate);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("scriptPath 越过输出目录");
  return real;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}
