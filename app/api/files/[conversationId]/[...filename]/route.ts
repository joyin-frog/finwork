import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getConversationFilesDir } from "@/lib/runtime/paths";
import { isAllowedAppPath, isValidConversationId } from "./open-with-allowlist";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string; filename: string[] }> }
) {
  const { conversationId, filename } = await params;
  if (!isValidConversationId(conversationId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const relativePath = filename.join("/");
  const fullPath = path.join(getConversationFilesDir(conversationId), relativePath);

  // Prevent path traversal
  const resolved = path.resolve(fullPath);
  const root = path.resolve(getConversationFilesDir(conversationId));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get("action") === "open") {
      const app = url.searchParams.get("app") ?? undefined;
      if (app && !isAllowedAppPath(app)) {
        return NextResponse.json({ error: "app not allowed" }, { status: 400 });
      }
      try {
        await openWithSystemApp(resolved, app);
      } catch {
        return NextResponse.json(
          { ok: false, error: "打开失败：未找到可用的应用。可换「在文件夹中显示」后手动打开。" },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true });
    }
    if (url.searchParams.get("action") === "reveal") {
      try {
        await revealInFileManager(resolved);
      } catch {
        return NextResponse.json(
          { ok: false, error: "显示失败：无法打开文件管理器。请确认文件管理器可正常使用。" },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true });
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = getContentType(ext);

    const stream = createReadStream(resolved);
    const readable = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk: Buffer | string) => controller.enqueue(new Uint8Array(Buffer.from(chunk))));
        stream.on("end", () => controller.close());
        stream.on("error", (err: Error) => controller.error(err));
      },
      cancel() {
        stream.destroy();
      }
    });

    return new Response(readable, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileStat.size),
        "Content-Disposition": `inline; filename="${encodeURIComponent(path.basename(resolved))}"`,
        "Cache-Control": "private, max-age=3600"
      }
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

function openWithSystemApp(filePath: string, appPath?: string) {
  if (process.platform === "win32" && appPath === "__choose__") {
    return spawnDetached("rundll32", ["shell32.dll,OpenAs_RunDLL", filePath]);
  }

  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32"
    ? appPath
      ? ["/c", "start", "", appPath, filePath]
      : ["/c", "start", "", filePath]
    : process.platform === "darwin" && appPath
      ? ["-a", appPath, filePath]
      : appPath
        ? [appPath, filePath]
        : [filePath];
  if (process.platform === "linux" && appPath) {
    return spawnDetached(appPath, [filePath]);
  }
  return spawnDetached(command, args);
}

function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => { child.unref(); resolve(); });
    child.once("error", reject);
  });
}

function revealInFileManager(filePath: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const args = process.platform === "darwin"
    ? ["-R", filePath]
    : process.platform === "win32"
      ? ["/select,", filePath]
      : [path.dirname(filePath)];
  return spawnDetached(command, args);
}

function getContentType(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".html": "text/html",
  };
  return map[ext] ?? "application/octet-stream";
}
