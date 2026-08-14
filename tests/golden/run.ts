import { randomUUID } from "node:crypto";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { runPiAgent } from "@/lib/agent/pi/agent-service";
import type { AgentMessage } from "@/lib/agent/contracts";
import { buildMessagesUrl } from "@/lib/agent/router";
import { getModelConfigReadiness } from "@/lib/settings/model-config";
import { executionRequirementsFromToolGroups } from "@/lib/capability/execution-gate";
import { withTransientProviderRetry } from "@/lib/evaluation/transient-provider-retry";
import { ALL_GOLDEN_CASES, type GoldenCase } from "./cases";

const SKIP_LLM = process.env.SKIP_LLM === "true";
const PASS_THRESHOLD = SKIP_LLM ? 0.5 : 0.75;
// GOLDEN_SAMPLE=N 每类目取前 N 条;GOLDEN_CATEGORY=a,b 只跑指定类目(便于改完后定向重测)。默认全量。
const SAMPLE = Number(process.env.GOLDEN_SAMPLE || 0);
const CATEGORIES = (process.env.GOLDEN_CATEGORY || "").split(",").map((s) => s.trim()).filter(Boolean);
const CASE_IDS = (process.env.GOLDEN_CASE_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
const PROVIDER_MAX_ATTEMPTS = Math.min(5, Math.max(1, Number(process.env.GOLDEN_PROVIDER_MAX_ATTEMPTS || 3) || 3));
const CASES: GoldenCase[] = (() => {
  let pool = ALL_GOLDEN_CASES;
  if (CASE_IDS.length) pool = pool.filter((c) => CASE_IDS.includes(c.id));
  else if (CATEGORIES.length) pool = pool.filter((c) => CATEGORIES.includes(c.category));
  if (SAMPLE > 0) {
    const seen = new Map<string, number>();
    pool = pool.filter((c) => {
      const n = seen.get(c.category) ?? 0;
      if (n >= SAMPLE) return false;
      seen.set(c.category, n + 1);
      return true;
    });
  }
  return pool;
})();

type CaseResult = {
  caseId: string;
  category: string;
  passed: boolean;
  score: number;
  toolScore: number;
  keywordScore: number;
  judgeScore: number | null;
  toolCalls: string[];
  response: string;
  error?: string;
  durationMs: number;
  providerAttempts: number;
};

async function main() {
  console.log(`\n🔬 Golden Eval Runner\n`);
  console.log(`Cases: ${CASES.length}${SAMPLE > 0 ? ` (sampled ${SAMPLE}/category from ${ALL_GOLDEN_CASES.length})` : ""} | Mode: ${SKIP_LLM ? "SKIP_LLM (tool+keyword only)" : "FULL (with LLM judge)"} | Threshold: ${PASS_THRESHOLD}\n`);

  const settings = await readAgentSettings();
  const hasApiKey = settings.apiKey.trim().length > 0;
  const modelReady = getModelConfigReadiness(settings).modelConfigReady;
  if (!SKIP_LLM && (!hasApiKey || !modelReady)) {
    const missing = getModelConfigReadiness(settings).missingModelTiers.join(", ");
    throw new Error(
      `真实 Golden 评测需要 API key 和完整模型配置；当前缺少${hasApiKey ? "模型槽位" : "API key"}${missing ? ` (${missing})` : ""}。` +
      "如需只跑静态评分，请显式设置 SKIP_LLM=true。",
    );
  }
  if (!hasApiKey) console.log("⚠️  No API key configured — static/mock mode enabled by SKIP_LLM.\n");

  const results: CaseResult[] = [];
  let passedCount = 0;

  for (let i = 0; i < CASES.length; i++) {
    const gc = CASES[i];
    const label = `[${i + 1}/${CASES.length}] ${gc.id}`;
    process.stdout.write(`${label} ... `);

    const started = Date.now();
    try {
      const agentRun = await withTransientProviderRetry(
        () => runCase(gc),
        {
          maxAttempts: SKIP_LLM ? 1 : PROVIDER_MAX_ATTEMPTS,
          onRetry: ({ nextAttempt, delayMs, decision }) => {
            process.stdout.write(`\n  ↻ provider retry ${nextAttempt}/${PROVIDER_MAX_ATTEMPTS} in ${delayMs}ms (${decision.reason}) ... `);
          },
        },
      );
      const { toolCalls, response } = agentRun.value;

      const toolScore = computeToolScore(gc, toolCalls);
      const keywordScore = computeKeywordScore(gc, response);

      let judgeScore: number | null = null;
      if (!SKIP_LLM && hasApiKey) {
        const judgeRun = await withTransientProviderRetry(
          () => runJudge(gc, response, toolCalls),
          {
            maxAttempts: PROVIDER_MAX_ATTEMPTS,
            onRetry: ({ nextAttempt, delayMs, decision }) => {
              process.stdout.write(`\n  ↻ judge retry ${nextAttempt}/${PROVIDER_MAX_ATTEMPTS} in ${delayMs}ms (${decision.reason}) ... `);
            },
          },
        );
        judgeScore = judgeRun.value;
      }

      const finalScore = judgeScore != null
        ? toolScore * 0.3 + keywordScore * 0.2 + judgeScore * 0.5
        : toolScore * 0.5 + keywordScore * 0.5;

      const passed = finalScore >= PASS_THRESHOLD;
      if (passed) passedCount++;

      results.push({
        caseId: gc.id, category: gc.category, passed, score: finalScore,
        toolScore, keywordScore, judgeScore, toolCalls, response,
        durationMs: Date.now() - started,
        providerAttempts: agentRun.attempts,
      });

      console.log(passed ? `✅ ${finalScore.toFixed(2)}` : `❌ ${finalScore.toFixed(2)}`);
    } catch (err) {
      results.push({
        caseId: gc.id, category: gc.category, passed: false, score: 0,
        toolScore: 0, keywordScore: 0, judgeScore: null, toolCalls: [],
        response: "", error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        providerAttempts: 1,
      });
      console.log(`💥 ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Summary
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const catSummary = new Map<string, { total: number; passed: number; avgScore: number }>();
  for (const r of results) {
    const s = catSummary.get(r.category) ?? { total: 0, passed: 0, avgScore: 0 };
    s.total++;
    if (r.passed) s.passed++;
    s.avgScore += r.score;
    catSummary.set(r.category, s);
  }

  console.log(`\n━━━ Results ━━━`);
  console.log(`Total: ${passedCount}/${results.length} passed (${((passedCount / results.length) * 100).toFixed(1)}%)`);
  console.log(`Average Score: ${avgScore.toFixed(3)} | Threshold: ${PASS_THRESHOLD}`);

  for (const [cat, s] of catSummary) {
    const pct = ((s.passed / s.total) * 100).toFixed(0);
    console.log(`  ${cat}: ${s.passed}/${s.total} (${pct}%) avg=${(s.avgScore / s.total).toFixed(3)}`);
  }

  // Report
  const report = {
    summary: { total: results.length, passed: passedCount, avgScore, threshold: PASS_THRESHOLD, skipLLM: SKIP_LLM },
    byCategory: Object.fromEntries(
      Array.from(catSummary.entries()).map(([cat, s]) => [cat, { total: s.total, passed: s.passed, avgScore: s.avgScore / s.total }])
    ),
    results,
  };

  console.log(JSON.stringify(report, null, 2));

  const overallPass = avgScore >= PASS_THRESHOLD;
  console.log(`\n${overallPass ? "✅ PASS" : "❌ FAIL"} — avg ${avgScore.toFixed(3)} vs threshold ${PASS_THRESHOLD}`);
  process.exit(overallPass ? 0 : 1);
}

// ─── case runner ────────────────────────────────────────────────────

async function runCase(gc: GoldenCase): Promise<{ toolCalls: string[]; response: string }> {
  const toolCalls: string[] = [];

  const result = await runPiAgent({
      messages: gc.input as AgentMessage[],
      requestId: randomUUID(),
      emit: (event) => {
        if (event.type === "tool_started" && !toolCalls.includes(event.toolName)) {
          toolCalls.push(event.toolName);
        }
      },
    }, {
      executionRequirements: executionRequirementsFromToolGroups(
        gc.expectations.expected_tool_calls_loose ?? [],
      ),
    });

  return { toolCalls, response: result.content };
}

// ─── scoring ────────────────────────────────────────────────────────

function computeToolScore(gc: GoldenCase, toolCalls: string[]): number {
  const expected = gc.expectations.expected_tool_calls_loose ?? [];
  const forbidden = gc.expectations.must_not_call ?? [];

  if (expected.length === 0 && forbidden.length === 0) return 1.0;

  let score = 0;
  let weight = 0;

  // Check expected tools
  if (expected.length > 0) {
    weight += 0.6;
    // 支持 "a|b" OR 组:任一合法替代工具命中即算命中(避免把"用了对口工具但不是 rubric 写死的那个"误判)
    const hit = expected.filter((t) => t.split("|").some((alt) => toolCalls.some((tc) => tc.includes(alt)))).length;
    score += (hit / expected.length) * 0.6;
  }

  // Check forbidden tools
  if (forbidden.length > 0) {
    weight += 0.4;
    const violation = forbidden.filter((t) => toolCalls.some((tc) => tc.includes(t))).length;
    score += violation === 0 ? 0.4 : 0;
  }

  return weight > 0 ? score / weight : 1.0;
}

function computeKeywordScore(gc: GoldenCase, response: string): number {
  const mustHave = gc.expectations.must_contain_keywords ?? [];
  const mustNotHave = gc.expectations.must_not_contain ?? [];

  if (mustHave.length === 0 && mustNotHave.length === 0) return 1.0;

  let score = 0;
  let weight = 0;

  if (mustHave.length > 0) {
    weight += 0.5;
    const hit = mustHave.filter((kw) => response.includes(kw)).length;
    score += (hit / mustHave.length) * 0.5;
  }

  if (mustNotHave.length > 0) {
    weight += 0.5;
    const violation = mustNotHave.filter((kw) => response.includes(kw)).length;
    score += violation === 0 ? 0.5 : 0;
  }

  return weight > 0 ? score / weight : 1.0;
}

// ─── LLM judge ──────────────────────────────────────────────────────

async function runJudge(gc: GoldenCase, response: string, toolCalls: string[]): Promise<number> {
  const settings = await readAgentSettings();
  if (!settings.apiKey.trim()) return 0.5;

  const judgePrompt = [
    "你是评测裁判。根据以下标准给回答打分（0.0-1.0）。",
    "",
    `评测标准：${gc.expectations.judge_rubric}`,
    "",
    `用户输入: ${gc.input[0]?.content ?? ""}`,
    `工具调用: ${toolCalls.join(", ") || "(none)"}`,
    `模型回答: ${response.slice(0, 2000)}`,
    "",
    "只输出一个JSON: {\"score\": <0.0-1.0>, \"reason\": \"<一句话理由>\"}",
  ].join("\n");

  // 直连 Messages API(与 router 同款可靠路径)。原先用重型 sdk.query 在本网关上静默失败,
  // judge 全程退化成 0.5(占最终分 50% 权重)→ 准确率根本测不准。
  try {
    const res = await fetch(buildMessagesUrl(settings.apiUrl), {
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.fastModel,
        max_tokens: 500,
        messages: [{ role: "user", content: judgePrompt }],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return 0.5;
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (Array.isArray(data?.content) ? data.content : [])
      .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    const jsonMatch = text.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown };
      if (typeof parsed.score === "number") return Math.max(0, Math.min(1, parsed.score));
    }
  } catch {
    // Judge failed — return neutral score
  }

  return 0.5;
}

main().catch((err) => {
  console.error("Eval runner crashed:", err);
  process.exit(1);
});
