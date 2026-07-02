import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPythonPath, getProjectRoot } from "../lib/runtime/paths.ts";
import { createReadDocumentTool } from "../lib/agent/mcp-tools/read-document.ts";

// read_document:让 agent 直接取上传单据的文本。按类型路由 extract-text(PDF/Excel/Word)/ocr-image(图片),
// 图片与扫描件 PDF 自动 OCR。修复真机故障:agent 曾自己写 pytesseract(没装)卡死。
function rapidocrAvailable(python: string): boolean {
  try {
    return spawnSync(python, ["-c", "import rapidocr_onnxruntime"], { encoding: "utf-8" }).status === 0;
  } catch {
    return false;
  }
}
function makeTextPdf(python: string, pdfPath: string, text: string): boolean {
  const script = `
import sys
from reportlab.pdfgen import canvas
c = canvas.Canvas(sys.argv[1]); c.drawString(100, 700, sys.argv[2]); c.save()
`.trim();
  return spawnSync(python, ["-c", script, pdfPath, text], { encoding: "utf-8" }).status === 0;
}

export const readDocumentTestPromise = (async () => {
  // 提取 handler(mockSdk)
  const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = { tool: (name: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => { handlers.set(name, h); return { name }; } };
  createReadDocumentTool(mockSdk);
  const read = handlers.get("read_document")!;

  // ── RD1: 不支持的类型 → 可操作错误(不静默)──
  const bad = (await read({ filePath: "/tmp/x.zip" })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.ok(bad.content[0].text.length > 0, "RD1 FAIL: 应返回错误说明");

  // ── RD2: 文件不存在 → 明确报错 ──
  const missing = (await read({ filePath: "/tmp/nope-12345.pdf" })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.ok(/不存在|not found|失败/.test(missing.content[0].text), "RD2 FAIL: 文件不存在应明确报错");

  const python = getPythonPath();
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-readdoc-"));
  try {
    // ── RD3: 文字型 PDF → extract-text ──
    const pdf = path.join(dir, "t.pdf");
    if (makeTextPdf(python, pdf, "RECEIPT-REF-445566")) {
      const out = (await read({ filePath: pdf })) as { content: Array<{ text: string }> };
      assert.ok(out.content[0].text.includes("445566"), `RD3 FAIL: 文字型 PDF 应取出文本,实际: ${out.content[0].text.slice(0, 150)}`);
      console.log("read-document: RD3 文字型 PDF → extract-text ✓");
    } else {
      console.log("read-document: reportlab 不可用,跳过 RD3 ⚠");
    }

    // ── RD4: 图片(扫描件)→ ocr-image(仅 rapidocr 可用时)──
    if (!rapidocrAvailable(python)) {
      console.log("read-document: rapidocr 不可用,跳过 RD4 真跑 OCR ⚠");
    } else {
      const imgScript = `
import sys
from PIL import Image, ImageDraw
img = Image.new("RGB", (400, 120), "white")
ImageDraw.Draw(img).text((20, 40), sys.argv[2], fill="black")
img.save(sys.argv[1])
`.trim();
      const img = path.join(dir, "s.png");
      if (spawnSync(python, ["-c", imgScript, img, "998877"], { encoding: "utf-8" }).status === 0) {
        const out = (await read({ filePath: img })) as { content: Array<{ text: string }> };
        assert.ok(out.content[0].text.trim().length > 0, "RD4 FAIL: 图片应 OCR 出非空文本");
        console.log(`read-document: RD4 图片 → ocr-image ✓ (识别: "${out.content[0].text.trim().slice(0, 30)}")`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("read-document: 类型路由 / 错误处理 / PDF·图片取文本 ✓");
})();
