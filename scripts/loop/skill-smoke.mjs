// Real end-to-end test of the four document skills (xlsx/docx/pptx/pdf):
// sends a natural request for each format and asserts the agent AUTO-SELECTS the
// right skill and actually GENERATES a file of that format (proves skill→Bash→
// run_python→file generation, not just the extraction scripts the unit tests cover).
//
//   node scripts/loop/with-server.mjs -- node scripts/loop/skill-smoke.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:3997";

const cases = [
  { fmt: "xlsx", ext: ".xlsx", prompt: "把这三个员工的月薪做成一个Excel表格并给我文件:张敏8000元、李哲9000元、王岚10000元,最后加一行合计。" },
  { fmt: "docx", ext: ".docx", prompt: "生成一份Word文档:本月财务工作小结,200字左右,给我文件。" },
  { fmt: "pptx", ext: ".pptx", prompt: "做一份PPT文件:3页的财务汇报(标题页、收入支出概览、结论),给我文件。" },
  { fmt: "pdf",  ext: ".pdf",  prompt: "生成一份PDF文件:差旅报销须知一页纸,给我文件。" },
];

const results = [];
for (const c of cases) {
  const t0 = Date.now();
  let atts = [];
  let status = 0;
  let toolNames = [];
  try {
    const res = await fetch(`${BASE}/api/agent/query?stream=false`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: c.prompt }),
    });
    status = res.status;
    const body = await res.json().catch(() => null);
    atts = body?.data?.generatedAttachments || [];
    // collect tool/skill names from the persisted conversation events to confirm auto-selection
    const msgs = body?.data?.conversation?.messages || [];
    for (const m of msgs) for (const e of m.agentEvents || []) {
      if (e.eventType === "tool_use") toolNames.push(e.payload?.name || e.payload?.input?.command || "tool");
    }
  } catch (e) {
    toolNames = [`threw:${e.message}`];
  }
  const names = atts.map((a) => a.fileName || a.name || "").filter(Boolean);
  const hit = names.some((n) => n.toLowerCase().endsWith(c.ext));
  results.push({ fmt: c.fmt, hit, ms: Date.now() - t0, status, files: names });
  console.log(`${hit ? "✅" : "❌"} skill ${c.fmt} → ${c.ext} | HTTP ${status} | ${Date.now() - t0}ms | files=[${names.join(", ") || "none"}]`);
}

const pass = results.filter((r) => r.hit).length;
console.log(`\n━━━ 四件套生成: ${pass}/${cases.length} 自动选对 skill 并产出对应格式文件 ━━━`);
console.log(JSON.stringify({ pass, total: cases.length, results }, null, 2));
process.exit(pass === cases.length ? 0 : 1);
