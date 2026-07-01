// 知识库沙箱命令的 Node 实现:不再 spawn 系统 coreutils(Windows 没有),
// 只有 rg 走打包二进制,其余命令在 Node 内对文本流做纯变换。安全边界仍由 query-sandbox 的
// tokenize + validatePipeline 把守(本文件只在已校验的 argv 上工作)。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getRgPath } from "@/lib/knowledge/rg-binary";

export class SandboxRunError extends Error {}

/** 把 argv 拆成 flags(以 - 开头)与操作数(文件名等) */
function splitArgs(args: string[]): { flags: string[]; operands: string[] } {
  const flags: string[] = [];
  const operands: string[] = [];
  for (const a of args) (a.startsWith("-") && a !== "-" ? flags : operands).push(a);
  return { flags, operands };
}

/** 把操作数解析为 cwd 内的真实文件;越界由上游 validatePipeline 已拦,这里再保险一次 */
function resolveFiles(operands: string[], cwd: string): string[] {
  const files: string[] = [];
  for (const name of operands) {
    const resolved = path.resolve(cwd, name);
    if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
      throw new SandboxRunError(`不允许越出知识库目录「${name}」`);
    }
    files.push(resolved);
  }
  return files;
}

function readFilesOrStdin(operands: string[], cwd: string, stdin: string): string {
  if (operands.length === 0) return stdin;
  return resolveFiles(operands, cwd)
    .map((f) => (existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf-8") : ""))
    .join("");
}

function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // 末尾换行不算空行
  return lines;
}

/** head/tail 的行数:支持 `-20`、`-n 20`、`-n20`、`--lines=20` */
function headTailCount(args: string[]): { n: number; operands: string[] } {
  const operands: string[] = [];
  let n = 10;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "-n") {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) { n = Number(next); i += 1; continue; }
    }
    let m = a.match(/^-n?(\d+)$/) || a.match(/^--lines=(\d+)$/);
    if (m) { n = Number(m[1]); continue; }
    if (a.startsWith("-")) continue; // 忽略未知 flag
    operands.push(a);
  }
  return { n, operands };
}

const RG_OUTPUT_CAP = 500_000; // 防 rg 输出失控(管道末尾还会再截到 maxOutput)

async function runRgBinary(args: string[], cwd: string, stdin: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(getRgPath(), args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      if (out.length < RG_OUTPUT_CAP) out += c.toString();
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    child.on("error", (e) => reject(new SandboxRunError(`rg 执行失败:${e.message}`)));
    child.on("close", (code) => {
      if (code === 0 || code === 1 || out.length >= RG_OUTPUT_CAP) resolve(out); // 1 = 无匹配,正常
      else reject(new SandboxRunError(err.trim() || `rg 退出码 ${code}`));
    });
    // rg 的搜索目标常已由 argv(文件名/操作数)给出,不一定读 stdin,可能在 Node 写完前就退出并
    // 关闭读端 → child.stdin.end() 写入 EPIPE。真实结果看上面的 close/exit code,这里只需吞掉
    // 该写入错误,否则 Writable 的 'error' 事件无监听会让整个进程崩溃(异步、in-flight,不受
    // try/catch 保护)。
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

/** 执行单个已校验的命令段:rg 走打包二进制,其余在 Node 内变换 */
export async function runSegment(cmd: string, args: string[], stdin: string, cwd: string, isFirst: boolean): Promise<string> {
  switch (cmd) {
    case "rg":
    case "grep": {
      // grep 统一交给打包 rg(超集);保留常用 flag,补默认搜索路径
      const mapped = cmd === "grep" ? mapGrepToRg(args) : [...args];
      const { operands } = splitArgs(mapped);
      const hasPath = operands.some((a) => existsSync(path.join(cwd, a)));
      if (isFirst && !hasPath) mapped.push("."); // 首段无文件 → 搜当前目录
      return runRgBinary(mapped, cwd, isFirst && !hasPath ? null : stdin);
    }
    case "cat": {
      const { operands } = splitArgs(args);
      return readFilesOrStdin(operands, cwd, stdin);
    }
    case "head": {
      const { n, operands } = headTailCount(args);
      const lines = toLines(readFilesOrStdin(operands, cwd, stdin));
      return lines.slice(0, n).join("\n") + (lines.length ? "\n" : "");
    }
    case "tail": {
      const { n, operands } = headTailCount(args);
      const lines = toLines(readFilesOrStdin(operands, cwd, stdin));
      return lines.slice(-n).join("\n") + (lines.length ? "\n" : "");
    }
    case "wc": {
      const { flags, operands } = splitArgs(args);
      const text = readFilesOrStdin(operands, cwd, stdin);
      const lines = toLines(text).length;
      const words = text.split(/\s+/).filter(Boolean).length;
      const bytes = Buffer.byteLength(text, "utf-8");
      if (flags.includes("-l")) return `${lines}\n`;
      if (flags.includes("-w")) return `${words}\n`;
      if (flags.includes("-c") || flags.includes("-m")) return `${bytes}\n`;
      return `${lines} ${words} ${bytes}\n`;
    }
    case "sort": {
      const { flags, operands } = splitArgs(args);
      let lines = toLines(readFilesOrStdin(operands, cwd, stdin));
      lines = flags.includes("-n")
        ? lines.sort((a, b) => parseFloat(a) - parseFloat(b))
        : lines.sort((a, b) => a.localeCompare(b));
      if (flags.includes("-r")) lines.reverse();
      if (flags.includes("-u")) lines = [...new Set(lines)];
      return lines.join("\n") + (lines.length ? "\n" : "");
    }
    case "uniq": {
      const { flags, operands } = splitArgs(args);
      const lines = toLines(readFilesOrStdin(operands, cwd, stdin));
      const out: string[] = [];
      const counts: number[] = [];
      for (const l of lines) {
        if (out.length && out[out.length - 1] === l) counts[counts.length - 1] += 1;
        else { out.push(l); counts.push(1); }
      }
      let result = out;
      if (flags.includes("-d")) result = out.filter((_, i) => counts[i] > 1);
      const rendered = flags.includes("-c")
        ? result.map((l) => `${String(counts[out.indexOf(l)]).padStart(7)} ${l}`)
        : result;
      return rendered.join("\n") + (rendered.length ? "\n" : "");
    }
    case "cut": {
      const { operands } = splitArgs(args);
      const delim = (args[args.indexOf("-d") + 1] ?? "\t");
      const fieldSpec = (args[args.indexOf("-f") + 1] ?? "");
      const charSpec = (args[args.indexOf("-c") + 1] ?? "");
      const fileOperands = operands.filter((o) => o !== delim && o !== fieldSpec && o !== charSpec);
      const lines = toLines(readFilesOrStdin(fileOperands, cwd, stdin));
      const idxs = parseRangeSpec(args.includes("-f") ? fieldSpec : charSpec);
      return lines
        .map((l) => {
          if (args.includes("-f")) {
            const parts = l.split(delim);
            return idxs.map((i) => parts[i - 1] ?? "").join(delim);
          }
          return idxs.map((i) => l[i - 1] ?? "").join("");
        })
        .join("\n") + (lines.length ? "\n" : "");
    }
    case "tr": {
      const { flags, operands } = splitArgs(args);
      if (flags.includes("-d")) {
        const set = operands[0] ?? "";
        const re = new RegExp(`[${escapeRe(set)}]`, "g");
        return stdin.replace(re, "");
      }
      const [from, to] = operands;
      if (!from || !to) return stdin;
      return stdin.replace(new RegExp(`[${escapeRe(from)}]`, "g"), (ch) => {
        const i = from.indexOf(ch);
        return to[Math.min(i, to.length - 1)] ?? ch;
      });
    }
    case "ls": {
      const entries = readdirSync(cwd).filter((e) => !e.startsWith("."));
      entries.sort((a, b) => a.localeCompare(b));
      return entries.join("\n") + (entries.length ? "\n" : "");
    }
    case "find": {
      const nameIdx = args.indexOf("-name");
      const pattern = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
      const wantFilesOnly = args.includes("-type") && args[args.indexOf("-type") + 1] === "f";
      const results = walkDir(cwd, cwd, pattern, wantFilesOnly);
      return results.join("\n") + (results.length ? "\n" : "");
    }
    default:
      throw new SandboxRunError(`不支持的命令「${cmd}」`);
  }
}

function mapGrepToRg(args: string[]): string[] {
  // grep 常用 flag 直接透传给 rg(语义兼容):-i -n -v -c -l -e -w
  return args.filter((a) => a !== "-E" && a !== "-r" && a !== "-R");
}

function parseRangeSpec(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) { for (let i = Number(m[1]); i <= Number(m[2]); i += 1) out.push(i); }
    else if (/^\d+$/.test(part)) out.push(Number(part));
  }
  return out.length ? out : [1];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walkDir(dir: string, root: string, namePattern: string | undefined, filesOnly: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const rel = "./" + path.relative(root, full);
    const nameOk = !namePattern || matchGlob(entry.name, namePattern);
    if (entry.isDirectory()) {
      if (!filesOnly && nameOk) out.push(rel);
      out.push(...walkDir(full, root, namePattern, filesOnly));
    } else if (nameOk) {
      out.push(rel);
    }
  }
  return out;
}

function matchGlob(name: string, pattern: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
  return re.test(name);
}
