/**
 * System LibreOffice resolver (CR-S1).
 * Priority: managed (optional empty) → OS standard paths → PATH soffice/libreoffice.
 * Callers must use the returned absolute executable; never spawn bare "soffice".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export type LibreOfficeResolveOk = {
  ok: true;
  provider: "system_libreoffice" | "managed_libreoffice";
  executable: string;
  version?: string;
};

export type LibreOfficeResolveUnavailable = {
  ok: false;
  errorCode: "recalc_unavailable";
  detail: string;
  /** OS-specific install guidance for settings / waiting_dependency UI. */
  installHint: string;
};

export type LibreOfficeResolveResult = LibreOfficeResolveOk | LibreOfficeResolveUnavailable;

export type LibreOfficeResolverDeps = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  pathEnv?: string;
  exists?: (p: string) => boolean;
  /** Absolute paths for a future managed LO install (CR-X2). Empty in v1. */
  managedCandidates?: string[];
  /** Run `executable --version` (or equivalent); return stdout or null. */
  readVersion?: (executable: string) => string | null;
  which?: (names: string[]) => string | null;
};

function defaultInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "请安装 LibreOffice（https://www.libreoffice.org/download/ 或 `brew install --cask libreoffice`），安装后点击「重新检测」。";
  }
  if (platform === "win32") {
    return "请安装 LibreOffice（https://www.libreoffice.org/download/），安装后点击「重新检测」。";
  }
  return "请通过发行版软件源安装 LibreOffice（如 `sudo apt install libreoffice`），安装后点击「重新检测」。";
}

function parseVersion(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/LibreOffice\s+(\d+(?:\.\d+)+)/i) ?? raw.match(/(\d+(?:\.\d+)+)/);
  return m?.[1];
}

function defaultReadVersion(executable: string): string | null {
  try {
    const out = execFileSync(executable, ["--version"], {
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

function defaultWhich(names: string[], pathEnv: string, exists: (p: string) => boolean): string | null {
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".bat", ".cmd"] : [""];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (exists(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Standard install locations by platform (absolute paths). */
export function systemLibreOfficeCandidates(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      path.join(homeDir, "Applications/LibreOffice.app/Contents/MacOS/soffice"),
    ];
  }
  if (platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
    return [
      path.join(programFiles, "LibreOffice", "program", "soffice.exe"),
      path.join(programFilesX86, "LibreOffice", "program", "soffice.exe"),
      path.join(localAppData, "Programs", "LibreOffice", "program", "soffice.exe"),
    ];
  }
  // linux + others
  return [
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/usr/lib/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
  ];
}

/**
 * Resolve LibreOffice executable for recalc/render.
 * Never returns a bare command name — always an absolute path when ok.
 */
export function resolveLibreOffice(deps: LibreOfficeResolverDeps = {}): LibreOfficeResolveResult {
  const platform = deps.platform ?? process.platform;
  const homeDir = deps.homeDir ?? os.homedir();
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  const exists = deps.exists ?? fs.existsSync;
  const readVersion = deps.readVersion ?? defaultReadVersion;
  const managed = deps.managedCandidates ?? [];
  const which =
    deps.which ??
    ((names: string[]) => defaultWhich(names, pathEnv, exists));

  const tryPath = (
    executable: string,
    provider: LibreOfficeResolveOk["provider"]
  ): LibreOfficeResolveOk | null => {
    if (!path.isAbsolute(executable)) return null;
    if (!exists(executable)) return null;
    const version = parseVersion(readVersion(executable));
    return { ok: true, provider, executable, version };
  };

  for (const candidate of managed) {
    const hit = tryPath(candidate, "managed_libreoffice");
    if (hit) return hit;
  }

  for (const candidate of systemLibreOfficeCandidates(platform, homeDir)) {
    const hit = tryPath(candidate, "system_libreoffice");
    if (hit) return hit;
  }

  const fromPath = which(["soffice", "libreoffice"]);
  if (fromPath) {
    const absolute = path.isAbsolute(fromPath) ? fromPath : path.resolve(fromPath);
    const hit = tryPath(absolute, "system_libreoffice");
    if (hit) return hit;
  }

  return {
    ok: false,
    errorCode: "recalc_unavailable",
    detail: "未找到 LibreOffice，公式重算与正式渲染不可用。",
    installHint: defaultInstallHint(platform),
  };
}
