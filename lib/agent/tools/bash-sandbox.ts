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
  const readRoot = canonical(roots.readRoot);
  const readRoots = [...new Set((roots.readRoots ?? []).map(canonical).filter((root) => root !== readRoot))];
  const writeRoot = canonical(roots.writeRoot);
  const home = canonical(os.homedir());
  return [
    "(version 1)",
    "(deny default)",
    // 进程与信号：不放开则连管道都起不来。
    "(allow process-exec process-fork signal sysctl-read)",
    // 系统路径可读，否则任何命令都无法加载动态库。
    "(allow file-read*)",
    // 家目录整体不可读——真账本、.ssh、Documents 都在这里。
    `(deny file-read* (subpath ${sbplString(home)}))`,
    // 会话目录重新放开（覆盖上一条），含用户本次上传的附件。
    `(allow file-read* (subpath ${sbplString(readRoot)}))`,
    ...readRoots.map((root) => `(allow file-read* (subpath ${sbplString(root)}))`),
    // 标准设备：不放开则 `>/dev/null`、管道、tty 交互全断。
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")',
    '                       (literal "/dev/dtracehelper") (literal "/dev/tty"))',
    '(allow file-ioctl (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    // 唯一可写区：本回合输出目录。
    `(allow file-write* (subpath ${sbplString(writeRoot)}))`,
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
