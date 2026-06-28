// 知识库受限命令沙箱:让 agent 用多步命令钻取知识库,但只读、不经 shell、不可逃逸。
// 安全模型:自研 tokenizer 解析管道 → 逐段白名单校验 → spawn 链直连(无 shell)→ 超时+截断。

import { runSegment } from "@/lib/knowledge/sandbox-commands";

// 只放行无脚本级执行/写入能力的命令。
// 刻意排除 awk(getline|cmd 可执行命令)与 sed(w/r/e 脚本命令可写文件/读任意文件/执行),
// 它们的能力无法靠字符串分析安全收敛;取指定行段用 head|tail 组合替代。
const ALLOWED_COMMANDS = new Set([
  "rg", "grep", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "ls", "find", "tr"
]);

// 出现这些 shell 元字符(引号外)即拒绝:命令分隔、重定向、命令替换、后台
const SHELL_METACHARS = /[;&|<>`$()]/;

export type ParsedPipeline = { segments: string[][] };

export class SandboxError extends Error {}

/**
 * 将命令行解析为管道分段(每段是 argv 数组)。
 * 支持单/双引号;引号外出现命令替换/重定向/分号/后台符即拒绝;`|` 是唯一允许的分段符。
 */
export function tokenizePipeline(command: string): ParsedPipeline {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  const pushToken = () => {
    if (hasToken) {
      current.push(token);
      token = "";
      hasToken = false;
    }
  };
  const pushSegment = () => {
    pushToken();
    if (current.length === 0) throw new SandboxError("管道中存在空命令段");
    segments.push(current);
    current = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else {
        token += ch;
        hasToken = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true; // 空引号也算一个 token(如 tr -d '')
      continue;
    }
    if (ch === "|") {
      pushSegment();
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushToken();
      continue;
    }
    if (SHELL_METACHARS.test(ch)) {
      throw new SandboxError(`命令含不允许的字符「${ch}」(只读检索不支持重定向、命令替换、命令串联)`);
    }
    token += ch;
    hasToken = true;
  }
  if (quote) throw new SandboxError("引号未闭合");
  pushSegment();

  return { segments };
}

/** 逐段白名单与危险参数校验 */
export function validatePipeline(pipeline: ParsedPipeline): void {
  for (const segment of pipeline.segments) {
    const [cmd, ...args] = segment;
    if (!ALLOWED_COMMANDS.has(cmd)) {
      throw new SandboxError(`不允许的命令「${cmd}」。可用:${[...ALLOWED_COMMANDS].join(" ")}`);
    }
    for (const arg of args) {
      if (arg.startsWith("/")) throw new SandboxError(`不允许绝对路径参数「${arg}」`);
      if (arg === ".." || arg.includes("../") || arg.includes("/..")) {
        throw new SandboxError(`不允许越出知识库目录「${arg}」`);
      }
    }
    if (cmd === "find" && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a))) {
      throw new SandboxError("find 不允许执行型/写入型动作(-exec/-delete/-fprint 等)");
    }
    if ((cmd === "rg" || cmd === "grep") && args.some((a) => a.startsWith("--pre") || a === "-f" || a.startsWith("--file"))) {
      throw new SandboxError(`${cmd} 不允许 --pre/-f(可触发外部执行或读取任意文件)`);
    }
    if (cmd === "sort" && args.some((a) => a === "-o" || a.startsWith("-o") || a.startsWith("--output"))) {
      throw new SandboxError("sort 不允许 -o/--output(写文件)");
    }
    if (cmd === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) {
      throw new SandboxError("uniq 只允许读取单个文件(第二个文件操作数会被写入)");
    }
    if (cmd === "tee") {
      throw new SandboxError("tee 不允许(写文件)");
    }
  }
}

export type PipelineResult = { stdout: string; truncated: boolean; exitCode: number | null };

/**
 * 顺序执行管道:每段在 Node 内对文本流做变换(rg 走打包二进制),全程不经 shell、不调系统 coreutils。
 * 跨平台(含 Windows);安全边界由 tokenize + validatePipeline 把守,本函数只在已校验 argv 上工作。
 */
export async function runPipeline(
  segments: string[][],
  cwd: string,
  opts: { timeoutMs?: number; maxOutput?: number } = {}
): Promise<PipelineResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxOutput = opts.maxOutput ?? 20_000;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SandboxError(`命令执行超时(>${timeoutMs}ms),请缩小检索范围`)), timeoutMs);
  });

  const exec = (async () => {
    let input = "";
    for (let i = 0; i < segments.length; i += 1) {
      const [cmd, ...args] = segments[i];
      input = await runSegment(cmd, args, input, cwd, i === 0);
    }
    return input;
  })();

  try {
    let out = await Promise.race([exec, timeout]);
    let truncated = false;
    if (out.length > maxOutput) {
      out = out.slice(0, maxOutput);
      truncated = true;
    }
    return { stdout: out, truncated, exitCode: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ExecuteResult = { ok: true; output: string; truncated: boolean } | { ok: false; error: string };

export async function executeKnowledgeQuery(command: string, cwd: string): Promise<ExecuteResult> {
  try {
    const pipeline = tokenizePipeline(command);
    validatePipeline(pipeline);
    const { stdout, truncated } = await runPipeline(pipeline.segments, cwd);
    return { ok: true, output: stdout, truncated };
  } catch (err) {
    if (err instanceof SandboxError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
