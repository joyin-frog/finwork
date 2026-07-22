/**
 * POST /api/local/open-folder
 * 用系统文件管理器打开本机目录(桌面/Next dev 共用)。
 * body: { path: string } — 必须是已存在的绝对目录路径。
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { path?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "无效请求" }, { status: 400 });
  }
  const raw = typeof body.path === "string" ? body.path.trim() : "";
  if (!raw) {
    return NextResponse.json({ ok: false, error: "缺少路径" }, { status: 400 });
  }
  if (!path.isAbsolute(raw)) {
    return NextResponse.json({ ok: false, error: "仅支持绝对路径" }, { status: 400 });
  }
  const resolved = path.resolve(raw);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return NextResponse.json({ ok: false, error: "文件夹不存在" }, { status: 404 });
  }

  try {
    await openFolderInFileManager(resolved);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[open-folder]", err);
    return NextResponse.json({ ok: false, error: "打开失败" }, { status: 500 });
  }
}

function openFolderInFileManager(folderPath: string) {
  // 打开目录本身(不是 -R 选中文件):macOS open / win explorer / linux xdg-open。
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const args = [folderPath];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}
