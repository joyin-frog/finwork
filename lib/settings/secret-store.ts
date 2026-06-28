// API Key 不落明文:把密钥从 local-settings.json 挪进系统密钥库。
// - macOS:登录钥匙串(security CLI,无原生依赖)
// - Windows:DPAPI 加密文件(按当前用户绑定,换机/换用户即失效),无原生依赖
// - 其它(Linux / CI / 开发):回落到独立明文文件并告警 —— 非发布目标平台
//
// 后端按平台自动选;可用 FINANCE_AGENT_SECRET_BACKEND=keychain|dpapi|file 强制(测试用)。
// 安全边界:所有外部命令走 execFile(无 shell),密钥经 argv(macOS)或 env(Windows)传递、不进 shell 字符串。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getSecretFallbackPath } from "@/lib/runtime/paths";

const execFileAsync = promisify(execFile);

const SERVICE = "com.gyro.financeagent";
const ACCOUNT = "anthropic-api-key";

type Backend = "keychain" | "dpapi" | "file";

function pickBackend(): Backend {
  const forced = process.env.FINANCE_AGENT_SECRET_BACKEND;
  if (forced === "keychain" || forced === "dpapi" || forced === "file") return forced;
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "win32") return "dpapi";
  return "file";
}

// 进程内缓存:避免每次调用 shell 出 security CLI / PowerShell。
// null = 未初始化;"" = 已读取但无 key。
let cached: string | null = null;

/** 仅测试用:重置进程内缓存,使下一次 getApiKeySecret() 重新从后端读取。 */
export function _resetSecretCache(): void {
  cached = null;
}

async function readBackend(): Promise<string> {
  switch (pickBackend()) {
    case "keychain":
      return await keychainGet();
    case "dpapi":
      return await dpapiGet();
    default:
      return await fileGet();
  }
}

async function writeBackend(v: string): Promise<void> {
  switch (pickBackend()) {
    case "keychain":
      return await keychainSet(v);
    case "dpapi":
      return await dpapiSet(v);
    default:
      return await fileSet(v);
  }
}

/** 读取 API Key;任何后端失败都回退空串(上层据此回落 mock Agent),绝不抛。缓存进程内,避免重复 shell。 */
export async function getApiKeySecret(): Promise<string> {
  if (cached !== null) return cached;
  try {
    const v = await readBackend();
    cached = v;
    return v;
  } catch (err) {
    console.warn("[secret-store] read failed", err);
    return "";
  }
}

/**
 * 写入 API Key;空串=删除。
 * 返回 true 表示成功,false 表示后端写入失败(不抛异常,调用方可据此提示用户)。
 * 成功后更新进程内缓存;失败时缓存保持不变。
 */
export async function setApiKeySecret(value: string): Promise<boolean> {
  const v = value.trim();
  try {
    await writeBackend(v);
    cached = v;
    return true;
  } catch (err) {
    console.warn("[secret-store] write failed", err);
    return false;
  }
}

// ── macOS 登录钥匙串 ─────────────────────────────────────────────
async function keychainGet(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w",
    ]);
    return stdout.replace(/\n$/, "");
  } catch {
    return ""; // 未找到时 security 以非零退出
  }
}

async function keychainSet(value: string): Promise<void> {
  if (!value) {
    await execFileAsync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]).catch(() => {});
    return;
  }
  // -U:已存在则更新(否则 add 会因重名报错)
  await execFileAsync("security", [
    "add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", value,
  ]);
}

// ── Windows DPAPI 加密文件(按当前用户绑定) ─────────────────────
async function dpapiSet(value: string): Promise<void> {
  const file = getSecretFallbackPath();
  if (!value) {
    await fs.rm(file, { force: true }).catch(() => {});
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const ps = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$b=[Text.Encoding]::UTF8.GetBytes($env:FA_SECRET)",
    "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')",
    "[IO.File]::WriteAllText($env:FA_SECRET_FILE,[Convert]::ToBase64String($p))",
  ].join("; ");
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, FA_SECRET: value, FA_SECRET_FILE: file },
  });
}

async function dpapiGet(): Promise<string> {
  const file = getSecretFallbackPath();
  try {
    await fs.access(file);
  } catch {
    return "";
  }
  const ps = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$t=[IO.File]::ReadAllText($env:FA_SECRET_FILE)",
    "$p=[Convert]::FromBase64String($t)",
    "$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser')",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, FA_SECRET_FILE: file },
  });
  return stdout;
}

// ── 回落:独立明文文件(仅非发布目标平台 / CI / 开发) ───────────
async function fileGet(): Promise<string> {
  try {
    return (await fs.readFile(getSecretFallbackPath(), "utf-8")).trim();
  } catch {
    return "";
  }
}

async function fileSet(value: string): Promise<void> {
  const file = getSecretFallbackPath();
  if (!value) {
    await fs.rm(file, { force: true }).catch(() => {});
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, { encoding: "utf-8", mode: 0o600 });
  console.warn(`[secret-store] 当前平台无系统密钥库,API Key 以明文存于 ${file}(非发布目标平台)`);
}
