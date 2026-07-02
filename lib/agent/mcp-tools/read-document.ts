import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getPythonPath, getProjectRoot } from "@/lib/runtime/paths";
import type { SdkLike } from "./sdk-types";

// 文档类(有文字层用 pdfplumber/openpyxl;扫描件 PDF 走 OCR 兜底)
const TEXT_EXTS = [".pdf", ".xlsx", ".xls", ".docx", ".pptx"];
// 图片类(直接 OCR)
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

/**
 * read_document:让 agent 直接取上传单据/文件的文本,不必自己写 OCR。
 * 按扩展名路由 worker 的 extract-text / ocr-image(rapidocr);扫描件 PDF 在 extract-text 内自动 OCR 兜底。
 * 修复真机故障——agent 曾对上传单据用 run_python 自己 import pytesseract(没装)卡死。
 */
export function createReadDocumentTool(sdk: SdkLike) {
  return sdk.tool(
    "read_document",
    "读取用户上传的单据/文件的文本内容:PDF/Excel/Word 提取文字(扫描件 PDF 自动 OCR),图片(png/jpg/jpeg/webp)自动 OCR。输入文件绝对路径,返回全文。**处理上传的单据、发票、回单、对账单时用本工具,不要自己写 OCR 代码。**",
    { filePath: z.string().describe("文件绝对路径") },
    async (args: { filePath: string }) => {
      const filePath = String(args.filePath ?? "").trim();
      if (!filePath || !existsSync(filePath)) {
        return { content: [{ type: "text" as const, text: `文件不存在:${filePath}` }], isError: true as const };
      }
      const ext = path.extname(filePath).toLowerCase();
      const cmd = TEXT_EXTS.includes(ext) ? "extract-text" : IMAGE_EXTS.includes(ext) ? "ocr-image" : null;
      if (!cmd) {
        return {
          content: [{ type: "text" as const, text: `不支持的文件类型 ${ext}。支持:PDF / Excel / Word / 图片(png/jpg/jpeg/webp)。` }],
          isError: true as const,
        };
      }
      try {
        const worker = path.join(getProjectRoot(), "workers", "finance_worker.py");
        const out = execFileSync(getPythonPath(), [worker, cmd, filePath], {
          encoding: "utf-8",
          maxBuffer: 20 * 1024 * 1024,
          timeout: 180_000,
          env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        });
        const text = out.trim();
        return { content: [{ type: "text" as const, text: text || "(未提取到文本;若为扫描件请确认清晰度)" }] };
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        const hint = (e.stderr ?? "").toString().trim() || e.message || "未知错误";
        return { content: [{ type: "text" as const, text: `读取失败:${hint.slice(0, 500)}` }], isError: true as const };
      }
    }
  );
}
