import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPythonPath, getBundledPluginRoot } from "../lib/runtime/paths.ts";

// 自写 pdf skill 的行为测试:真实造 PDF → extract_form_structure.py 提取结构 → pypdf 合并。
export const skillPdfTestPromise = (async () => {
  const skillDir = path.join(getBundledPluginRoot(), "skills", "pdf");
  const structureScript = path.join(skillDir, "scripts", "extract_form_structure.py");
  const python = getPythonPath();

  // ── AC-PDF1: skill 结构合法 ─────────────────────────────────────────
  const skillMd = readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
  assert.match(skillMd, /^---[\s\S]*?\nname:\s*pdf\b/m, "AC-PDF1 FAIL: SKILL.md frontmatter 应含 name: pdf");
  assert.match(skillMd, /\ndescription:\s*\S/, "AC-PDF1 FAIL: 应有 description");
  assert.ok(existsSync(structureScript), "AC-PDF1 FAIL: 应存在 scripts/extract_form_structure.py");
  // 财务关键:必须提醒扫描件读不到、不可猜
  assert.match(skillMd, /扫描件/, "AC-PDF1 FAIL: 应警示扫描件无文本层不可猜数");

  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-skill-pdf-"));
  try {
    if (!existsSync(python)) {
      console.log("skill-pdf: python 运行时缺失,跳过行为执行(结构检查已通过)⚠");
      return;
    }

    // ── AC-PDF2: 造一份含已知文本的电子版 PDF(reportlab)──────────────
    const a = path.join(dir, "a.pdf");
    const b = path.join(dir, "b.pdf");
    const mkPdf = (file: string, line: string) =>
      [
        "from reportlab.pdfgen import canvas",
        "from reportlab.lib.pagesizes import A4",
        `c = canvas.Canvas(r'${file}', pagesize=A4)`,
        "c.setFont('Helvetica', 12)",
        `c.drawString(72, 760, ${JSON.stringify(line)})`,
        "c.showPage(); c.save()",
      ].join("\n");
    execFileSync(python, ["-c", mkPdf(a, "INVOICE TOTAL 1234.56")], { stdio: "pipe" });
    execFileSync(python, ["-c", mkPdf(b, "PAGE TWO CONTENT")], { stdio: "pipe" });
    assert.ok(existsSync(a) && existsSync(b), "AC-PDF2 FAIL: 样例 PDF 应生成");

    // ── AC-PDF3: extract_form_structure.py 提取出文本结构 ───────────────
    const structureJson = path.join(dir, "structure.json");
    execFileSync(python, [structureScript, a, structureJson], { stdio: "pipe" });
    const report = JSON.parse(readFileSync(structureJson, "utf-8"));
    assert.equal(report.pages.length, 1, "AC-PDF3 FAIL: 应为 1 页");
    assert.ok(
      report.labels.some((label: { text: string }) => label.text === "INVOICE"),
      "AC-PDF3 FAIL: 应提取出已知文本结构"
    );

    // ── AC-PDF4: pypdf 合并两份 → 2 页(skill 宣称的合并能力可用)─────────
    const merged = path.join(dir, "merged.pdf");
    const mergeCode = [
      "from pypdf import PdfReader, PdfWriter",
      "w = PdfWriter()",
      `for f in [r'${a}', r'${b}']:`,
      "    [w.add_page(p) for p in PdfReader(f).pages]",
      `fh = open(r'${merged}','wb'); w.write(fh); fh.close()`,
    ].join("\n");
    execFileSync(python, ["-c", mergeCode], { stdio: "pipe" });
    const mergedStructureJson = path.join(dir, "merged-structure.json");
    execFileSync(python, [structureScript, merged, mergedStructureJson], { stdio: "pipe" });
    const mergedReport = JSON.parse(readFileSync(mergedStructureJson, "utf-8"));
    assert.equal(mergedReport.pages.length, 2, "AC-PDF4 FAIL: 合并后应为 2 页");

    console.log("skill-pdf: all checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
