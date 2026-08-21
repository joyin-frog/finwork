import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getFileWorkspaceKeyPath } from "@/lib/runtime/paths";

const execFileAsync = promisify(execFile);
const SERVICE = "com.gyro.financeagent";
const ACCOUNT = "file-workspace-master-key";
let cached: Buffer | null = null;
let inflight: Promise<Buffer> | null = null;
type Backend = "keychain" | "dpapi" | "file";

function pickBackend(): Backend {
  const forced = process.env.FINANCE_AGENT_FILE_KEY_BACKEND ?? process.env.FINANCE_AGENT_SECRET_BACKEND;
  if (forced === "keychain" || forced === "dpapi" || forced === "file") return forced;
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "win32") return "dpapi";
  return "file";
}

function envKey(): Buffer | null {
  const raw = process.env.FINANCE_AGENT_FILE_MASTER_KEY?.trim();
  if (!raw) return null;
  const decoded = Buffer.from(raw, /^[a-f0-9]{64}$/i.test(raw) ? "hex" : "base64");
  if (decoded.length !== 32) throw new Error("FINANCE_AGENT_FILE_MASTER_KEY 必须是 32 字节 hex/base64");
  return decoded;
}

export function _resetFileWorkspaceKeyCache(): void {
  cached = null;
  inflight = null;
}

export async function getFileWorkspaceMasterKey(): Promise<Buffer> {
  if (cached) return Buffer.from(cached);
  inflight ??= loadOrCreateMasterKey();
  try {
    const key = await inflight;
    cached = Buffer.from(key);
    return Buffer.from(key);
  } finally {
    inflight = null;
  }
}

async function loadOrCreateMasterKey(): Promise<Buffer> {
  const injected = envKey();
  if (injected) return Buffer.from(injected);
  const backend = pickBackend();
  const encoded = backend === "keychain"
    ? await keychainGet()
    : backend === "dpapi"
      ? await dpapiGet()
      : await fileGet();
  if (encoded) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("文件工作区主密钥格式损坏");
    return Buffer.from(key);
  }
  const created = randomBytes(32);
  const value = created.toString("base64");
  if (backend === "keychain") await keychainSet(value);
  else if (backend === "dpapi") await dpapiSet(value);
  else await fileSet(value);
  return Buffer.from(created);
}

async function keychainGet(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    return stdout.trim();
  } catch { return ""; }
}

async function keychainSet(value: string): Promise<void> {
  await execFileAsync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", value]);
}

async function dpapiGet(): Promise<string> {
  const file = getFileWorkspaceKeyPath();
  try { await fs.access(file); } catch { return ""; }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$t=[IO.File]::ReadAllText($env:FA_KEY_FILE)",
    "$p=[Convert]::FromBase64String($t)",
    "$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser')",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, FA_KEY_FILE: file },
  });
  return stdout;
}

async function dpapiSet(value: string): Promise<void> {
  const file = getFileWorkspaceKeyPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const script = [
    "$ErrorActionPreference='Stop'",
    "$b=[Text.Encoding]::UTF8.GetBytes($env:FA_KEY)",
    "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')",
    "[IO.File]::WriteAllText($env:FA_KEY_FILE,[Convert]::ToBase64String($p))",
  ].join("; ");
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, FA_KEY: value, FA_KEY_FILE: file },
  });
}

async function fileGet(): Promise<string> {
  try { return (await fs.readFile(getFileWorkspaceKeyPath(), "utf8")).trim(); }
  catch { return ""; }
}

async function fileSet(value: string): Promise<void> {
  const file = getFileWorkspaceKeyPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, { encoding: "utf8", mode: 0o600 });
}
