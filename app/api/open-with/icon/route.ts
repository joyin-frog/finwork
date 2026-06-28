import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  if (process.platform !== "darwin") return NextResponse.json({ error: "unsupported" }, { status: 404 });

  const appPath = new URL(request.url).searchParams.get("path");
  if (!appPath || !path.isAbsolute(appPath) || !appPath.endsWith(".app")) {
    return NextResponse.json({ error: "invalid app path" }, { status: 400 });
  }

  try {
    const appStat = await stat(appPath);
    if (!appStat.isDirectory()) return NextResponse.json({ error: "not found" }, { status: 404 });

    const iconPath = await findMacAppIcon(appPath);
    if (!iconPath) return NextResponse.json({ error: "icon not found" }, { status: 404 });

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "finance-agent-icon-"));
    const pngPath = path.join(tmpDir, "icon.png");
    await run("sips", ["-s", "format", "png", iconPath, "--out", pngPath]);

    const stream = createReadStream(pngPath);
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

    stream.on("close", () => {
      void rm(tmpDir, { recursive: true, force: true });
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=86400"
      }
    });
  } catch {
    return NextResponse.json({ error: "icon not found" }, { status: 404 });
  }
}

async function findMacAppIcon(appPath: string) {
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  const declaredIcon = await readDeclaredIconName(infoPath);
  if (declaredIcon) {
    const iconName = declaredIcon.endsWith(".icns") ? declaredIcon : `${declaredIcon}.icns`;
    const iconPath = path.join(resourcesDir, iconName);
    try {
      const iconStat = await stat(iconPath);
      if (iconStat.isFile()) return iconPath;
    } catch {
      // Fall through to resource scan.
    }
  }

  const entries = await readdir(resourcesDir, { withFileTypes: true });
  const fallback = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".icns"));
  return fallback ? path.join(resourcesDir, fallback.name) : null;
}

async function readDeclaredIconName(infoPath: string) {
  try {
    const plist = await readFile(infoPath, "utf8");
    const match = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
