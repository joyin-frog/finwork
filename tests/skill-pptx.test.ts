import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPythonPath, getBundledPluginRoot } from "../lib/runtime/paths.ts";

// 自写 pptx skill 的行为测试:真实造 .pptx(标题+要点+备注)→ office/unpack.py 解包。
export const skillPptxTestPromise = (async () => {
  const skillDir = path.join(getBundledPluginRoot(), "skills", "pptx");
  const unpackScript = path.join(skillDir, "scripts", "office", "unpack.py");
  const python = getPythonPath();

  // ── AC-PPT1: skill 结构合法 ─────────────────────────────────────────
  const skillMd = readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
  assert.match(skillMd, /^---[\s\S]*?\nname:\s*pptx\b/m, "AC-PPT1 FAIL: frontmatter 应含 name: pptx");
  assert.match(skillMd, /\ndescription:\s*\S/, "AC-PPT1 FAIL: 应有 description");
  assert.ok(existsSync(unpackScript), "AC-PPT1 FAIL: 应存在 scripts/office/unpack.py");
  // 财务原则:结论先行 + 不编数
  assert.match(skillMd, /结论先行/, "AC-PPT1 FAIL: 应要求结论先行");
  assert.match(skillMd, /待补|不编|绝不编/, "AC-PPT1 FAIL: 应要求缺来源不编数");

  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-skill-pptx-"));
  try {
    if (!existsSync(python)) {
      console.log("skill-pptx: python 运行时缺失,跳过行为执行(结构检查已通过)⚠");
      return;
    }

    // ── AC-PPT2: 造一份含标题/要点/备注的 .pptx ────────────────────────
    const sample = path.join(dir, "deck.pptx");
    const buildCode = [
      "from pptx import Presentation",
      "prs = Presentation()",
      "s = prs.slides.add_slide(prs.slide_layouts[0])",
      "s.shapes.title.text = '6月经营汇报'",
      "s.placeholders[1].text = '利润38万 环比+12%'",
      "s2 = prs.slides.add_slide(prs.slide_layouts[1])",
      "s2.shapes.title.text = '收入'",
      "s2.placeholders[1].text_frame.text = '营业收入123.5万'",
      "s2.notes_slide.notes_text_frame.text = '口径:含税;来源:6月台账'",
      `prs.save(r'${sample}')`,
    ].join("\n");
    execFileSync(python, ["-c", buildCode], { stdio: "pipe" });
    assert.ok(existsSync(sample), "AC-PPT2 FAIL: 样例 pptx 应生成");

    // ── AC-PPT3: office/unpack.py 解包出幻灯片 XML 与备注 XML ───────────
    const unpacked = path.join(dir, "unpacked");
    execFileSync(python, [unpackScript, sample, unpacked], { stdio: "pipe" });
    const slide1Xml = readFileSync(path.join(unpacked, "ppt", "slides", "slide1.xml"), "utf-8");
    const notesDir = path.join(unpacked, "ppt", "notesSlides");
    const notesXml = readdirSync(notesDir)
      .filter((name) => name.endsWith(".xml"))
      .map((name) => readFileSync(path.join(notesDir, name), "utf-8"))
      .join("\n");
    assert.match(slide1Xml, /利润38万/, "AC-PPT3 FAIL: 应解包出结论页文字");
    assert.match(notesXml, /含税/, "AC-PPT3 FAIL: 应解包出讲者备注");

    console.log("skill-pptx: all checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
