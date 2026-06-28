import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPythonPath, getBundledPluginRoot } from "../lib/runtime/paths.ts";

// 自写 docx skill 的行为测试:真实造 .docx(含段落+表格)→ office/unpack.py 解包。
export const skillDocxTestPromise = (async () => {
  const skillDir = path.join(getBundledPluginRoot(), "skills", "docx");
  const unpackScript = path.join(skillDir, "scripts", "office", "unpack.py");
  const python = getPythonPath();

  // ── AC-DOC1: skill 结构合法 ─────────────────────────────────────────
  const skillMd = readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
  assert.match(skillMd, /^---[\s\S]*?\nname:\s*docx\b/m, "AC-DOC1 FAIL: frontmatter 应含 name: docx");
  assert.match(skillMd, /\ndescription:\s*\S/, "AC-DOC1 FAIL: 应有 description");
  assert.ok(existsSync(unpackScript), "AC-DOC1 FAIL: 应存在 scripts/office/unpack.py");
  // 财务诚实:必须说明改已有文档会丢格式
  assert.match(skillMd, /丢.*格式|格式.*丢/, "AC-DOC1 FAIL: 应告知就地改写会丢格式的限制");

  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-skill-docx-"));
  try {
    if (!existsSync(python)) {
      console.log("skill-docx: python 运行时缺失,跳过行为执行(结构检查已通过)⚠");
      return;
    }

    // ── AC-DOC2: 造一份含已知标题/段落/表格的 .docx ─────────────────────
    const sample = path.join(dir, "report.docx");
    const buildCode = [
      "from docx import Document",
      "doc = Document()",
      "doc.add_heading('财务情况说明', level=0)",
      "doc.add_paragraph('本月营业收入 1234560 元。')",
      "t = doc.add_table(rows=1, cols=2)",
      "t.rows[0].cells[0].text = '项目'; t.rows[0].cells[1].text = '金额'",
      "r = t.add_row().cells; r[0].text='收入'; r[1].text='1234560'",
      `doc.save(r'${sample}')`,
    ].join("\n");
    execFileSync(python, ["-c", buildCode], { stdio: "pipe" });
    assert.ok(existsSync(sample), "AC-DOC2 FAIL: 样例 docx 应生成");

    // ── AC-DOC3: office/unpack.py 解包出 document.xml ─────────────────
    const unpacked = path.join(dir, "unpacked");
    execFileSync(python, [unpackScript, sample, unpacked], { stdio: "pipe" });
    const documentXml = readFileSync(path.join(unpacked, "word", "document.xml"), "utf-8");
    assert.match(documentXml, /1234560/, "AC-DOC3 FAIL: 应解包出含金额的 document.xml");

    console.log("skill-docx: all checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
