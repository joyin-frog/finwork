import { createHash } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * bash 的**真**工作目录约束：OS 级沙箱。
 *
 * 为什么不是正则黑名单：shell 是图灵完备的，命令字符串上做模式匹配拦不住等价改写。
 * 实测同一批输入，5 条正则漏过 8/10——`rm -r -f ~/Documents`（把标志位分开写）、
 * `cat ~/.ssh/id_rsa`、`mv ~/账本.xlsx /tmp/`、`python3 -c "os.remove(...)"` 全部放行，
 * 而其中 `rm -rf ~/Documents` 却被拦——同一个操作，换个写法就绕过。
 *
 * pi 自己的答案也是 OS 沙箱（`examples/extensions/sandbox/`，用
 * `@anthropic-ai/sandbox-runtime`）。这里不引依赖，直接用 macOS 自带的 `sandbox-exec`：
 * 它按系统调用拦截，不关心命令怎么拼写。
 *
 * **fail-closed**：拿不到沙箱的平台（Windows / 未配置的 Linux）根本不注册 bash 工具，
 * 而不是退回到「有个正则闸聊胜于无」——那只会制造安全感。
 */

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type BashSandboxRoots = {
  /** 可读根：会话文件目录（含用户上传件）。 */
  readRoot: string;
  /** 额外的只读根：评测或导入流程中的附件目录；不授予写权限。 */
  readRoots?: string[];
  /** 可写根：本回合会话输出目录。 */
  writeRoot: string;
};

/** 沙箱是否可用。不可用时调用方必须不注册 bash（fail-closed）。 */
export function isBashSandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/**
 * 生成 SBPL profile。
 *
 * 规则次序有意义：SBPL 后匹配的规则覆盖先匹配的，所以「先全放读 → 再拒家目录 →
 * 再放会话目录」得到的净效果是「系统路径可读、家目录不可读、但会话目录可读」。
 * 这一点是实测确认的，不是照文档推的。
 */
export function buildBashSandboxProfile(roots: BashSandboxRoots): string {
  const readRoots = [...new Set([
    ...sandboxPathVariants(roots.readRoot),
    ...(roots.readRoots ?? []).flatMap(sandboxPathVariants),
  ])];
  const writeRoots = sandboxPathVariants(roots.writeRoot);
  const taskRoots = [...new Set([...readRoots, ...writeRoots])];
  const taskAncestors = [...new Set(taskRoots.flatMap(pathAncestors))];
  const systemReadRoots = [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library/Apple",
    "/Library/Fonts",
    // Development/runtime installations. These are read-only system package
    // prefixes, not user document roots; Homebrew Python links dylibs here.
    "/opt/homebrew",
    "/opt/local",
    "/private/var/db/timezone",
  ].filter(existsSync).map(canonical);
  return [
    "(version 1)",
    "(deny default)",
    // 进程与信号：不放开则连管道都起不来。
    "(allow process-exec process-fork signal sysctl-read)",
    // 只开放命令、动态库、字体和时区所需的系统根。不能先 allow file-read*，
    // 否则 /Volumes、其它用户目录和任意挂载盘都会绕过任务文件边界。
    // sh/Python 启动时会读取根目录项本身；literal 只放行 `/`，不会放行其子树。
    '(allow file-read-data (literal "/"))',
    '(allow file-read* (literal "/private/var/select/sh"))',
    ...systemReadRoots.map((root) => `(allow file-read* (subpath ${sbplString(root)}))`),
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")',
    '                  (literal "/dev/stdin") (literal "/dev/stdout") (literal "/dev/stderr")',
    '                  (literal "/dev/tty"))',
    // Sandbox path filters still need metadata access to every parent directory
    // in order to traverse into an allowed leaf. This permits stat/traversal,
    // not listing or reading sibling files.
    ...taskAncestors.map((root) => `(allow file-read-metadata (literal ${sbplString(root)}))`),
    // 会话输入、技能/运行时根和输出目录按白名单只读开放。
    ...readRoots.map((root) => `(allow file-read* (subpath ${sbplString(root)}))`),
    ...writeRoots.map((root) => `(allow file-read* (subpath ${sbplString(root)}))`),
    // 标准设备：不放开则 `>/dev/null`、管道、tty 交互全断。
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")',
    '                       (literal "/dev/dtracehelper") (literal "/dev/tty"))',
    '(allow file-ioctl (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    // 唯一可写区：本回合输出目录。
    ...writeRoots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`),
    // 动态任务代码没有隐式联网权限；联网必须走受控宿主工具。
    "(deny network*)",
  ].join("\n");
}

/**
 * 把命令包进沙箱。profile 落在临时目录并按内容哈希命名——同一组 roots 复用同一份，
 * 不必每次执行都写盘。
 */
export function wrapCommandWithSandbox(command: string, roots: BashSandboxRoots): string {
  const profile = buildBashSandboxProfile(roots);
  const digest = createHash("sha256").update(profile).digest("hex").slice(0, 16);
  const profilePath = path.join(os.tmpdir(), `finwork-bash-sandbox-${digest}.sb`);
  if (!existsSync(profilePath)) writeFileSync(profilePath, profile, "utf8");
  return `exec ${SANDBOX_EXEC} -f ${shellQuote(profilePath)} /bin/sh -c ${shellQuote(command)}`;
}

/** POSIX 单引号转义：唯一需要处理的是单引号本身。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** SBPL 字符串字面量：反斜杠和双引号需转义。 */
function sbplString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * 路径必须解到真实路径再进 profile。macOS 的 `/tmp` 是指向 `/private/tmp` 的软链，
 * 用未解析的路径写规则会得到一个「看起来配了、实际不匹配」的沙箱——本模块开发时
 * 第一版就踩了这个：允许区反而被拒。
 */
function canonical(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/** Seatbelt does not treat macOS' public `/var` and `/tmp` aliases as the same path. */
function sandboxPathVariants(target: string): string[] {
  const resolved = canonical(target);
  if (resolved === "/private/var" || resolved.startsWith("/private/var/")) {
    return [resolved, resolved.slice("/private".length)];
  }
  if (resolved === "/private/tmp" || resolved.startsWith("/private/tmp/")) {
    return [resolved, resolved.slice("/private".length)];
  }
  return [resolved];
}

function pathAncestors(target: string): string[] {
  const ancestors: string[] = [];
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    ancestors.push(current);
    current = path.dirname(current);
  }
  ancestors.push(current);
  return ancestors;
}
