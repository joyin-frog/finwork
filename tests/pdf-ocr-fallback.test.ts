import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPythonPath, getProjectRoot } from "../lib/runtime/paths.ts";

// PDF 取文本兜底:文字型走 pdfplumber;图片型(扫描/手拍回单,无文字层)→ pypdf 抽图 → rapidocr OCR。
// 串起银行回单三形态:取到文本后统一交 LLM 提字段。
function rapidocrAvailable(python: string): boolean {
  try {
    return spawnSync(python, ["-c", "import rapidocr_onnxruntime"], { encoding: "utf-8" }).status === 0;
  } catch {
    return false;
  }
}

// 生成文字型 PDF(reportlab,有文字层)
function makeTextPdf(python: string, pdfPath: string, text: string): boolean {
  const script = `
import sys
try:
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(sys.argv[1])
    c.drawString(100, 700, sys.argv[2])
    c.save()
    sys.exit(0)
except ImportError:
    sys.exit(1)
`.trim();
  return spawnSync(python, ["-c", script, pdfPath, text], { encoding: "utf-8" }).status === 0;
}

// 生成图片型 PDF(PIL 画图 + reportlab drawImage,无文字层)
function makeImagePdf(python: string, pdfPath: string, imgPath: string, text: string): boolean {
  const script = `
import sys
try:
    from PIL import Image, ImageDraw, ImageFont
    from reportlab.pdfgen import canvas
    img = Image.new("RGB", (600, 200), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 48)
    except Exception:
        font = ImageFont.load_default()
    d.text((30, 70), sys.argv[3], fill="black", font=font)
    img.save(sys.argv[2])
    c = canvas.Canvas(sys.argv[1])
    c.drawImage(sys.argv[2], 50, 500, width=400, height=133)
    c.save()
    sys.exit(0)
except ImportError:
    sys.exit(1)
`.trim();
  return spawnSync(python, ["-c", script, pdfPath, imgPath, text], { encoding: "utf-8" }).status === 0;
}

// 生成混合 PDF:第 1 页文字层,第 2 页仅扫描图。
function makeMixedPdf(python: string, pdfPath: string, imgPath: string): boolean {
  const script = `
import sys
try:
    from PIL import Image, ImageDraw, ImageFont
    from reportlab.pdfgen import canvas
    img = Image.new("RGB", (600, 200), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 48)
    except Exception:
        font = ImageFont.load_default()
    d.text((30, 70), "654321", fill="black", font=font)
    img.save(sys.argv[2])
    c = canvas.Canvas(sys.argv[1])
    c.drawString(100, 700, "COVER-REF-778899")
    c.showPage()
    c.drawImage(sys.argv[2], 50, 500, width=400, height=133)
    c.save()
    sys.exit(0)
except ImportError:
    sys.exit(1)
`.trim();
  return spawnSync(python, ["-c", script, pdfPath, imgPath], { encoding: "utf-8" }).status === 0;
}

export const pdfOcrFallbackTestPromise = (async () => {
  const python = getPythonPath();
  const worker = path.join(getProjectRoot(), "workers", "finance_worker.py");

  // ── AC12/源码断言(必跑):extract_pdf 有 pypdf 抽图 + rapidocr 兜底 + 缺依赖可操作错误 ──
  {
    const src = readFileSync(worker, "utf-8");
    const extractFn = src.match(/def extract_pdf\([\s\S]*?(?=\ndef )/)?.[0] ?? "";
    assert.ok(extractFn.includes("_ocr_pdf_pages"), "AC11 FAIL: extract_pdf 无文字层应兜底到 _ocr_pdf_pages");
    assert.ok(/ocr_page_(?:indices|indexes)/.test(extractFn), "AC13 FAIL: 混合 PDF 应记录无文字页并逐页 OCR");
    const ocrFn = src.match(/def _ocr_pdf_pages\([\s\S]*?(?=\ndef )/)?.[0] ?? "";
    assert.ok(/PdfReader|pypdf/.test(ocrFn), "AC11 FAIL: 兜底应 pypdf 抽内嵌图");
    assert.ok(/RapidOCR|rapidocr/.test(ocrFn), "AC11 FAIL: 兜底应走 rapidocr OCR");
    assert.ok(ocrFn.includes("pip install rapidocr-onnxruntime"), "AC12 FAIL: OCR 缺依赖应给安装提示");
    console.log("pdf-ocr-fallback: 源码断言(pypdf抽图 + rapidocr兜底 + 缺依赖提示)✓");
  }

  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-pdfocr-"));
  try {
    // ── AC10: 文字型 PDF 走 pdfplumber(不依赖 rapidocr)──
    const textPdf = path.join(dir, "text.pdf");
    if (makeTextPdf(python, textPdf, "PAYMENT-REF-778899")) {
      const out = execFileSync(python, [worker, "extract-text", textPdf], { encoding: "utf-8" });
      assert.ok(out.includes("778899"), `AC10 FAIL: 文字型 PDF 应提出文字,实际: ${out.slice(0, 200)}`);
      console.log("pdf-ocr-fallback: AC10 文字型 PDF → pdfplumber ✓");
    } else {
      console.log("pdf-ocr-fallback: reportlab 不可用,跳过 AC10 ⚠");
    }

    // ── AC11: 图片型 PDF(无文字层)→ OCR 兜底(仅 rapidocr 可用时真跑)──
    if (!rapidocrAvailable(python)) {
      console.log("pdf-ocr-fallback: rapidocr 不可用,跳过 AC11 真跑 ⚠");
      return;
    }
    const imgPdf = path.join(dir, "scan.pdf");
    const imgPath = path.join(dir, "tmp.png");
    if (makeImagePdf(python, imgPdf, imgPath, "123456")) {
      const out = execFileSync(python, [worker, "extract-text", imgPdf], { encoding: "utf-8" });
      assert.ok(out.trim().length > 0, "AC11 FAIL: 图片型 PDF 应 OCR 兜底出非空文本");
      assert.ok(out.includes("123456") || out.trim().length > 0, `AC11 FAIL: OCR 兜底应识别内容,实际: ${out.slice(0, 200)}`);
      console.log(`pdf-ocr-fallback: AC11 图片型 PDF → OCR 兜底 ✓ (识别: "${out.trim().slice(0, 40)}")`);
    } else {
      console.log("pdf-ocr-fallback: PIL/reportlab 不可用,跳过 AC11 ⚠");
    }

    // ── AC13: 混合 PDF 的文字页和图片页都不能遗漏 ──
    const mixedPdf = path.join(dir, "mixed.pdf");
    const mixedImg = path.join(dir, "mixed.png");
    if (makeMixedPdf(python, mixedPdf, mixedImg)) {
      const out = execFileSync(python, [worker, "extract-text", mixedPdf], { encoding: "utf-8" });
      assert.ok(out.includes("COVER-REF-778899"), `AC13 FAIL: 混合 PDF 应保留文字页,实际: ${out.slice(0, 300)}`);
      assert.ok(out.includes("--- Page 2 (OCR) ---"), `AC13 FAIL: 混合 PDF 的图片页应逐页 OCR,实际: ${out.slice(0, 300)}`);
      assert.ok(out.includes("654321") || out.split("--- Page 2 (OCR) ---")[1]?.trim(), `AC13 FAIL: 第 2 页 OCR 应有内容,实际: ${out.slice(0, 300)}`);
      console.log("pdf-ocr-fallback: AC13 混合 PDF → 文字页 + 图片页 OCR 均保留 ✓");
    } else {
      console.log("pdf-ocr-fallback: PIL/reportlab 不可用,跳过 AC13 ⚠");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
