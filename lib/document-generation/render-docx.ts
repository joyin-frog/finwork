import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { resolveLibreOffice } from "@/lib/runtime/libreoffice-resolver";

const RenderDocxRequestSchema = z.object({
  sourcePath: z.string().trim().min(1),
  outputRoot: z.string().trim().min(1),
  outputName: z.string().trim().min(1).max(255).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(120_000),
}).strict();

export type RenderedDocxPdf = {
  outputPath: string;
  bytes: number;
  sha256: string;
  provider: "system_libreoffice" | "managed_libreoffice";
  version?: string;
  durationMs: number;
};

function confinedOutputPath(outputRoot: string, outputName: string): string {
  if (path.basename(outputName) !== outputName || !/^[^/\\]+\.pdf$/i.test(outputName)) {
    throw new Error("document_render_invalid_output_name");
  }
  const root = path.resolve(outputRoot);
  const outputPath = path.resolve(root, outputName);
  if (path.dirname(outputPath) !== root) throw new Error("document_render_path_escape");
  return outputPath;
}

export function probeDocxPdfRenderer(): ReturnType<typeof resolveLibreOffice> {
  return resolveLibreOffice();
}

export function renderDocxToPdf(rawRequest: {
  sourcePath: string;
  outputRoot: string;
  outputName?: string;
  timeoutMs?: number;
}): RenderedDocxPdf {
  const request = RenderDocxRequestSchema.parse(rawRequest);
  const sourcePath = path.resolve(request.sourcePath);
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile() || !/\.docx$/i.test(sourcePath)) {
    throw new Error("document_render_source_invalid");
  }

  const renderer = resolveLibreOffice();
  if (!renderer.ok) throw new Error(`document_render_unavailable:${renderer.detail}`);
  if (!path.isAbsolute(renderer.executable)) throw new Error("document_render_executable_not_absolute");

  const outputRoot = path.resolve(request.outputRoot);
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const generatedName = `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`;
  const requestedName = request.outputName ?? generatedName;
  const generatedPath = confinedOutputPath(outputRoot, generatedName);
  const outputPath = confinedOutputPath(outputRoot, requestedName);
  if (existsSync(generatedPath) || (outputPath !== generatedPath && existsSync(outputPath))) {
    throw new Error("document_render_output_exists");
  }

  const profileRoot = mkdtempSync(path.join(os.tmpdir(), "finwork-lo-profile-"));
  const startedAt = performance.now();
  try {
    execFileSync(renderer.executable, [
      "--headless",
      "--nologo",
      "--nodefault",
      "--nofirststartwizard",
      `-env:UserInstallation=${pathToFileURL(profileRoot).href}`,
      "--convert-to",
      "pdf",
      "--outdir",
      outputRoot,
      sourcePath,
    ], {
      timeout: request.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  } catch (error) {
    throw new Error(`document_render_failed:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }

  if (!existsSync(generatedPath) || !statSync(generatedPath).isFile() || statSync(generatedPath).size === 0) {
    throw new Error("document_render_output_missing");
  }
  if (outputPath !== generatedPath) renameSync(generatedPath, outputPath);
  const bytes = readFileSync(outputPath);
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("document_render_invalid_pdf");
  }
  return {
    outputPath,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    provider: renderer.provider,
    ...(renderer.version ? { version: renderer.version } : {}),
    durationMs: performance.now() - startedAt,
  };
}
