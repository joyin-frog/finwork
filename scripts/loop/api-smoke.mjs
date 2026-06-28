// Real-API smoke + data-consistency sweep against a running server (sandbox env).
// Drives the full surface (cockpit/chat/agent/knowledge/memory/feedback/observability),
// makes GENUINE LLM calls through the configured gateway, asserts no 5xx + key side-effects,
// and emits latency/cost/token metrics for the loop scorer.
//
//   BASE_URL=http://127.0.0.1:3997 node scripts/loop/api-smoke.mjs
// Exit 0 = all checks pass; exit 1 = any failure.

const BASE = process.env.BASE_URL || "http://127.0.0.1:3997";
const checks = [];
const metrics = {};

function rec(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function http(method, path, { json, form, raw } = {}) {
  const opts = { method, headers: {} };
  if (json !== undefined) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(json); }
  if (form) opts.body = form;
  const res = await fetch(BASE + path, opts);
  let body = null;
  const ct = res.headers.get("content-type") || "";
  if (raw) body = await res.text();
  else if (ct.includes("application/json")) body = await res.json().catch(() => null);
  else body = await res.text().catch(() => null);
  return { status: res.status, body, res };
}

// A route is "alive" if it does NOT 5xx. 4xx on a validation route is acceptable.
async function expectAlive(name, method, path, opts) {
  try {
    const { status, body } = await http(method, path, opts);
    const ok = status < 500;
    rec(name, ok, `HTTP ${status}`);
    return { status, body };
  } catch (e) {
    rec(name, false, `threw ${e.message}`);
    return { status: 0, body: null };
  }
}
async function expect2xx(name, method, path, opts, assertFn) {
  try {
    const { status, body } = await http(method, path, opts);
    let ok = status >= 200 && status < 300;
    let detail = `HTTP ${status}`;
    if (ok && assertFn) {
      const a = assertFn(body);
      if (a !== true) { ok = false; detail += ` — assert: ${a}`; }
    }
    rec(name, ok, detail);
    return { status, body };
  } catch (e) {
    rec(name, false, `threw ${e.message}`);
    return { status: 0, body: null };
  }
}

async function agentTurn(prompt, { stream = false } = {}) {
  const t0 = Date.now();
  if (!stream) {
    const { status, body } = await http("POST", "/api/agent/query?stream=false", { json: { prompt } });
    return { status, body, ms: Date.now() - t0 };
  }
  // streaming: parse SSE, collect chunks + the terminal event
  const res = await fetch(`${BASE}/api/agent/query`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const text = await res.text();
  const events = text.split("\n\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l.replace(/^data: /, "")); } catch { return null; }
  }).filter(Boolean);
  return { status: res.status, events, ms: Date.now() - t0 };
}

async function main() {
  console.log(`\n🔬 API smoke @ ${BASE}\n`);

  // ─── Section A: read surface (no 5xx) ────────────────────────────────
  await expect2xx("cockpit/summary", "GET", "/api/cockpit/summary", {}, (b) =>
    b?.ok && b.data && "payroll" in b.data && "business" in b.data ? true : "missing payroll/business");
  await expect2xx("chat/recent", "GET", "/api/chat/recent", {}, (b) => (b?.ok ?? b?.data) ? true : "no ok/data");
  await expectAlive("analysis/summary", "GET", "/api/analysis/summary");
  await expect2xx("settings/claude", "GET", "/api/settings/claude", {}, (b) =>
    b?.apiKeyConfigured || b?.data?.apiKeyConfigured ? true : "apiKey not reported configured");
  await expectAlive("settings/doctor", "GET", "/api/settings/doctor");
  await expectAlive("metrics/tools", "GET", "/api/metrics/tools");
  await expectAlive("metrics/traces", "GET", "/api/metrics/traces");
  await expectAlive("open-with/apps", "GET", "/api/open-with/apps");

  // ─── Section B: agent turns (REAL LLM) ───────────────────────────────
  const greet = await agentTurn("你好");
  rec("agent: greeting (cheap path)", greet.status === 200 && !!greet.body?.data?.content,
    `HTTP ${greet.status}, ${greet.ms}ms, mode=${greet.body?.data?.mode}`);
  metrics.greetingMs = greet.ms;

  const pay = await agentTurn("请计算员工本月个税与实发：月薪20000元，五险一金2500元，专项附加扣除2000元，本年首月。");
  const payContent = pay.body?.data?.content || "";
  const payConvId = pay.body?.data?.conversationId;
  rec("agent: payroll (main path)", pay.status === 200 && /个税|实发|315|17,?185/.test(payContent),
    `HTTP ${pay.status}, ${pay.ms}ms, mode=${pay.body?.data?.mode}`);
  metrics.payrollMs = pay.ms;

  const stream = await agentTurn("用一句话说明什么是增值税", { stream: true });
  const doneEvt = stream.events?.find((e) => e.type === "done");
  const hadChunk = stream.events?.some((e) => e.type === "chunk" || e.type === "agent_event");
  rec("agent: SSE streaming", stream.status === 200 && !!doneEvt && hadChunk,
    `HTTP ${stream.status}, events=${stream.events?.length ?? 0}, done=${!!doneEvt}`);

  // grab an assistant messageId for feedback (from the payroll conversation)
  let assistantMsgId = null;
  if (payConvId) {
    const conv = await http("GET", `/api/chat/recent`);
    const list = conv.body?.data?.conversations || conv.body?.conversations || conv.body?.data || [];
    const target = Array.isArray(list) ? list.find((c) => c.id === payConvId) : null;
    const am = target?.messages?.filter?.((m) => m.role === "assistant");
    assistantMsgId = am?.length ? am[am.length - 1].id : null;
  }

  // ─── Section C: knowledge lifecycle (REAL ingest + search) ───────────
  const policyText = [
    "差旅费报销制度",
    "1. 市内交通费每日上限80元，需提供出租车或网约车发票。",
    "2. 招待费单次不得超过2000元，超过需总经理审批。",
    "3. 住宿费一线城市每晚上限600元，其他城市400元。",
  ].join("\n");
  const fd = new FormData();
  fd.append("file", new Blob([policyText], { type: "text/plain" }), "差旅报销制度.txt");
  fd.append("title", "差旅费报销制度");
  fd.append("category", "policy");
  const up = await expect2xx("knowledge: upload", "POST", "/api/knowledge/documents", { form: fd },
    (b) => b?.ok ? true : `upload not ok: ${JSON.stringify(b)?.slice(0, 120)}`);
  await expect2xx("knowledge: list", "GET", "/api/knowledge/documents", {}, (b) =>
    (b?.data?.documents?.length ?? 0) >= 1 ? true : "no documents listed");
  // verbatim term must hit — proves ingest→text-mirror→ripgrep pipeline is wired
  const srch = await expect2xx("knowledge: search (verbatim)", "POST", "/api/knowledge/search", { json: { query: "招待费" } },
    (b) => (b?.data?.files?.length ?? 0) >= 1 ? true : `verbatim '招待费' returned ${b?.data?.files?.length ?? 0} files`);
  metrics.knowledgeHits = srch.body?.data?.files?.length ?? 0;
  // non-verbatim term: literal --fixed-strings won't tokenize CJK; record only (P3 limitation), don't fail
  const nv = await http("POST", "/api/knowledge/search", { json: { query: "招待费上限" } });
  metrics.knowledgeNonVerbatimHits = nv.body?.data?.files?.length ?? 0;
  // P3:0 命中时分词 OR 兜底 → "招待费上限" 应召回含"招待费"的文档
  rec("knowledge: search (non-verbatim, P3 兜底)", metrics.knowledgeNonVerbatimHits >= 1, `files=${metrics.knowledgeNonVerbatimHits}(分词OR兜底)`);

  // ─── Section D: memory read/write ────────────────────────────────────
  const memText = `# 测试记忆\n- 公司简称：ztooo\n- 写入时间：${new Date().toISOString()}\n`;
  await expect2xx("memory: write (PUT)", "PUT", "/api/memory", { json: { content: memText } }, (b) => b?.ok ? true : "PUT not ok");
  await expect2xx("memory: read (GET)", "GET", "/api/memory", {}, (b) =>
    b?.data?.content?.includes("ztooo") ? true : "read-back mismatch");

  // ─── Section E: feedback + concurrency (shared-resource safety) ──────
  if (assistantMsgId) {
    await expect2xx("feedback: upsert", "POST", "/api/chat/feedback", { json: { messageId: assistantMsgId, rating: "up" } },
      (b) => b?.ok ? true : "feedback not ok");
    // concurrency: hammer the same messageId; must stay consistent + no 5xx
    const racers = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      http("POST", "/api/chat/feedback", { json: { messageId: assistantMsgId, rating: i % 2 ? "up" : "down", reason: `r${i}` } })
        .then((r) => r.status).catch(() => 0)));
    const no5xx = racers.every((s) => s < 500);
    rec("feedback: concurrent upsert (8x)", no5xx, `statuses=${racers.join(",")}`);
  } else {
    rec("feedback: upsert", false, "no assistant messageId captured");
  }
  // concurrent memory writes — shared file path
  const memRace = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    http("PUT", "/api/memory", { json: { content: `# 并发写 ${i}\n` } }).then((r) => r.status).catch(() => 0)));
  rec("memory: concurrent writes (6x)", memRace.every((s) => s < 500), `statuses=${memRace.join(",")}`);

  // ─── Section F: observability correlation ────────────────────────────
  const traces = await expect2xx("observability: traces", "GET", "/api/observability/traces", {}, (b) => {
    const arr = b?.data?.traces || b?.traces || b?.data || [];
    return Array.isArray(arr) && arr.length >= 2 ? true : `only ${Array.isArray(arr) ? arr.length : "?"} traces`;
  });
  const tArr = traces.body?.data?.traces || traces.body?.traces || traces.body?.data || [];
  const withCost = Array.isArray(tArr) ? tArr.find((t) => (t.total_cost_usd ?? t.totalCostUsd) > 0) : null;
  rec("observability: usage captured (cost+tokens)", !!withCost,
    withCost ? `cost=$${withCost.total_cost_usd ?? withCost.totalCostUsd}, in=${withCost.input_tokens ?? withCost.inputTokens}` : "no trace with cost>0");
  if (withCost) {
    metrics.sampleCostUsd = withCost.total_cost_usd ?? withCost.totalCostUsd;
    metrics.sampleInputTokens = withCost.input_tokens ?? withCost.inputTokens;
    metrics.sampleTotalMs = withCost.total_ms ?? withCost.totalMs;
    const tid = withCost.trace_id ?? withCost.traceId;
    await expect2xx("observability: spans", "GET", `/api/observability/spans?trace_id=${tid}`, {}, (b) => {
      const arr = b?.data?.spans || b?.spans || b?.data || [];
      return Array.isArray(arr) ? true : "spans not array";
    });
  }
  await expectAlive("observability: metrics", "GET", "/api/observability/metrics?days=7");
  await expectAlive("observability: export", "GET", "/api/observability/export");

  // ─── Summary ─────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n━━━ API smoke: ${checks.length - failed.length}/${checks.length} passed ━━━`);
  console.log(JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed: failed.map((f) => f.name), metrics }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("smoke crashed:", e); process.exit(1); });
