import assert from "node:assert/strict";
import { aggregateToolSegment, summarizeToolSegment } from "../app/chat/step-aggregate.ts";
import type { SegmentTimelineItem } from "../app/chat/turn-segments.ts";

// ─── helpers ───────────────────────────────────────────────────────────────

let _seq = 1;
function makeUse(name: string, id?: string): SegmentTimelineItem {
  const useId = id ?? `use-${_seq++}`;
  return { id: useId, event: { type: "tool_use", name, id: useId }, createdAt: Date.now() };
}

function makeResult(name: string, isError: boolean, toolUseId?: string, durationMs?: number): SegmentTimelineItem {
  return {
    id: `res-${_seq++}`,
    event: { type: "tool_result", name, isError, toolUseId, durationMs: durationMs ?? 500 },
    createdAt: Date.now(),
  };
}

/** 构建一对 (tool_use, tool_result) */
function pair(name: string, isError: boolean, durationMs?: number): [SegmentTimelineItem, SegmentTimelineItem] {
  const use = makeUse(name);
  const res = makeResult(name, isError, (use.event as { id?: string }).id, durationMs);
  return [use, res];
}

// ─── aggregateToolSegment 测试 ──────────────────────────────────────────────

export const stepAggregateTestPromise = (async () => {

  // ── A1: 空数组 → 空结果 ──
  {
    const result = aggregateToolSegment([]);
    assert.deepEqual(result, [], "A1 FAIL: 空数组应返回空结果");
  }

  // ── A2: 单个成功步骤 → kind:step, degraded:false ──
  {
    const [use, res] = pair("search_knowledge", false);
    const result = aggregateToolSegment([use, res]);
    assert.equal(result.length, 1, "A2 FAIL: 单个成功步应产出 1 个条目");
    const item = result[0];
    assert.equal(item.kind, "step", "A2 FAIL: 应为 kind:step");
    if (item.kind === "step") {
      assert.equal(item.degraded, false, "A2 FAIL: 单成功步 degraded 应为 false");
    }
  }

  // ── A3: 连续 ≥2 同工具失败后成功 → retry-group(recovered=true) ──
  {
    const [u1, r1] = pair("search_knowledge", true);
    const [u2, r2] = pair("search_knowledge", true);
    const [u3, r3] = pair("search_knowledge", true);
    const [u4, r4] = pair("search_knowledge", true);
    const [u5, r5] = pair("search_knowledge", false); // 恢复成功
    const items = [u1, r1, u2, r2, u3, r3, u4, r4, u5, r5];
    const result = aggregateToolSegment(items);

    // 应产出 1 个 retry-group + 1 个成功 step
    const groups = result.filter((x) => x.kind === "retry-group");
    const steps = result.filter((x) => x.kind === "step");
    assert.equal(groups.length, 1, "A3 FAIL: 应产出 1 个 retry-group");
    assert.equal(steps.length, 1, "A3 FAIL: 成功步应透传为 kind:step");

    const group = groups[0];
    assert.equal(group.kind, "retry-group", "A3 FAIL");
    if (group.kind === "retry-group") {
      assert.equal(group.count, 4, "A3 FAIL: count 应为 4");
      assert.equal(group.recovered, true, "A3 FAIL: recovered 应为 true（后面有同工具成功）");
      assert.ok(group.toolName === "search_knowledge", "A3 FAIL: toolName 应为 search_knowledge");
      assert.ok(group.label.includes("重试"), `A3 FAIL: label 应含「重试」，实际: ${group.label}`);
      assert.ok(group.label.includes("4") || group.label.includes("×4"), `A3 FAIL: label 应含重试次数，实际: ${group.label}`);
    }
  }

  // ── A4: 连续失败后无同工具成功 → retry-group(recovered=false) ──
  {
    const [u1, r1] = pair("query_knowledge", true);
    const [u2, r2] = pair("query_knowledge", true);
    const [u3, r3] = pair("query_knowledge", true);
    const result = aggregateToolSegment([u1, r1, u2, r2, u3, r3]);
    const groups = result.filter((x) => x.kind === "retry-group");
    assert.equal(groups.length, 1, "A4 FAIL: 应有 1 个 retry-group");
    const g = groups[0];
    if (g.kind === "retry-group") {
      assert.equal(g.recovered, false, "A4 FAIL: 无后续成功时 recovered=false");
      assert.equal(g.count, 3, "A4 FAIL: count 应为 3");
    }
  }

  // ── A5: 单个失败步之后同工具有成功 → kind:step, degraded:true ──
  {
    const [u1, r1] = pair("read_file", true);  // 单个失败
    const [u2, r2] = pair("read_file", false); // 后来成功
    const result = aggregateToolSegment([u1, r1, u2, r2]);
    const steps = result.filter((x) => x.kind === "step");
    assert.equal(steps.length, 2, "A5 FAIL: 应有 2 个 step");
    const failStep = steps[0];
    if (failStep.kind === "step") {
      assert.equal(failStep.degraded, true, "A5 FAIL: 单失败步后有同工具成功时 degraded 应为 true");
    }
    const successStep = steps[1];
    if (successStep.kind === "step") {
      assert.equal(successStep.degraded, false, "A5 FAIL: 成功步 degraded 应为 false");
    }
  }

  // ── A6: 穿插不同工具失败 → 不合并 retry-group ──
  {
    const [u1, r1] = pair("search_knowledge", true);
    const [u2, r2] = pair("read_file", true);          // 不同工具，打断
    const [u3, r3] = pair("search_knowledge", true);   // 不连续
    const result = aggregateToolSegment([u1, r1, u2, r2, u3, r3]);
    // 没有连续 ≥2 同工具 → 全是 kind:step
    const groups = result.filter((x) => x.kind === "retry-group");
    assert.equal(groups.length, 0, "A6 FAIL: 穿插不同工具不应合并为 retry-group");
    const steps = result.filter((x) => x.kind === "step");
    assert.equal(steps.length, 3, "A6 FAIL: 应有 3 个 step");
  }

  // ── A7: 恰好 2 个连续同工具失败 → 合并 retry-group（边界） ──
  {
    const [u1, r1] = pair("search_knowledge", true);
    const [u2, r2] = pair("search_knowledge", true);
    const result = aggregateToolSegment([u1, r1, u2, r2]);
    const groups = result.filter((x) => x.kind === "retry-group");
    assert.equal(groups.length, 1, "A7 FAIL: ≥2 连续同工具失败应产出 retry-group");
    if (groups[0].kind === "retry-group") {
      assert.equal(groups[0].count, 2, "A7 FAIL: count 应为 2");
    }
  }

  // ── A8: 成功步之后失败 → 成功步不 degraded ──
  {
    const [u1, r1] = pair("search_knowledge", false); // 成功
    const [u2, r2] = pair("search_knowledge", true);  // 失败（后面无恢复）
    const [u3, r3] = pair("search_knowledge", true);
    const result = aggregateToolSegment([u1, r1, u2, r2, u3, r3]);
    const successStep = result.find((x) => x.kind === "step");
    if (successStep?.kind === "step") {
      assert.equal(successStep.degraded, false, "A8 FAIL: 首个成功步不应因后续失败而 degraded");
    }
  }

  // ── A9: fixture conv65 结构 — 4 连败后恢复 → retry-group(count=4, recovered=true) ──
  // (与 docs/spec/fixtures/conv65-process.json 对齐的端到端断言)
  {
    const { default: fixture } = await import("../docs/spec/fixtures/conv65-process.json", { with: { type: "json" } });
    const timeline = (fixture as { items: SegmentTimelineItem[] }).items;
    const result = aggregateToolSegment(timeline);
    const groups = result.filter((x) => x.kind === "retry-group");
    assert.equal(groups.length, 1, "A9 FAIL: conv65 fixture 中应有 1 个 retry-group");
    const g = groups[0];
    if (g.kind === "retry-group") {
      assert.equal(g.count, 4, `A9 FAIL: retry-group count 应为 4，实际: ${g.count}`);
      assert.equal(g.recovered, true, "A9 FAIL: conv65 中 retry-group 应 recovered=true");
    }
  }

  // ── A-X: 跨段恢复——失败与重试成功被 thinking 段隔开(真实会话 65 场景) ──
  {
    const seg: SegmentTimelineItem[] = [];
    for (let k = 0; k < 4; k++) { const [u, r] = pair("search_knowledge", true); seg.push(u, r); }
    const later: SegmentTimelineItem[] = [];
    { const [u, r] = pair("search_knowledge", false); later.push(u, r); }

    // 不传 laterItems:段内无成功 → 保红
    const without = aggregateToolSegment(seg);
    assert.equal(without[0].kind, "retry-group", "A-X FAIL: 应聚合 retry-group");
    assert.equal((without[0] as { recovered: boolean }).recovered, false, "A-X FAIL: 无跨段信号应 recovered=false");

    // 传 laterItems:下一段同工具成功 → 已恢复
    const withLater = aggregateToolSegment(seg, later);
    assert.equal((withLater[0] as { recovered: boolean }).recovered, true, "A-X FAIL: 跨段成功应 recovered=true");

    // 单个失败步同理 degraded
    const single: SegmentTimelineItem[] = [];
    { const [u, r] = pair("read_document", true); single.push(u, r); }
    const singleAgg = aggregateToolSegment(single, (() => { const arr: SegmentTimelineItem[] = []; const [u, r] = pair("read_document", false); arr.push(u, r); return arr; })());
    assert.equal((singleAgg[0] as { degraded: boolean }).degraded, true, "A-X FAIL: 单失败步跨段成功应 degraded=true");
  }

  // ── A-P: 并行批量调用(u,u,u,u,r,r,r,r 事件序)按 toolUseId 配对,不产孤儿行 ──
  {
    const uses: SegmentTimelineItem[] = [];
    const results: SegmentTimelineItem[] = [];
    for (let k = 0; k < 4; k++) {
      uses.push({ id: `pu-${k}`, event: { type: "tool_use", name: "search_knowledge", id: `pu-${k}` }, createdAt: Date.now() });
      results.push({ id: `pr-${k}`, event: { type: "tool_result", name: "search_knowledge", isError: true, toolUseId: `pu-${k}`, durationMs: 20 }, createdAt: Date.now() });
    }
    const batch = [...uses, ...results]; // 并行批量:先 4 个 use 再 4 个 result
    const later: SegmentTimelineItem[] = [];
    { const [u, r] = pair("search_knowledge", false); later.push(u, r); }
    const agg = aggregateToolSegment(batch, later);
    assert.equal(agg.length, 1, `A-P FAIL: 4 组并行失败应聚成 1 个 retry-group,实际 ${agg.length} 项: ${agg.map(a => a.kind).join(",")}`);
    assert.equal(agg[0].kind, "retry-group", "A-P FAIL: 应为 retry-group");
    assert.equal((agg[0] as { count: number }).count, 4, "A-P FAIL: count 应为 4");
    assert.equal((agg[0] as { recovered: boolean }).recovered, true, "A-P FAIL: 跨段成功应 recovered=true");
  }

  console.log("step-aggregate: all checks passed ✓");
})();

// ─── summarizeToolSegment 测试 ──────────────────────────────────────────────

export const summarizeToolSegmentTestPromise = (async () => {

  // ── S1: 单一工具多步、无失败 → 工具名 + 步数 ──
  {
    const items: SegmentTimelineItem[] = [];
    for (let i = 0; i < 11; i++) {
      const [u, r] = pair("search_knowledge", false, 1000);
      items.push(u, r);
    }
    const summary = summarizeToolSegment(items);
    assert.ok(summary.includes("检索"), `S1 FAIL: summary 应含工具中文名，实际: ${summary}`);
    assert.ok(summary.includes("11") || summary.includes("×11"), `S1 FAIL: summary 应含步数 11，实际: ${summary}`);
    assert.ok(!summary.includes("重试"), `S1 FAIL: 无失败不应含「重试」，实际: ${summary}`);
  }

  // ── S2: 有失败步 → 含「重试」 ──
  {
    const items: SegmentTimelineItem[] = [];
    for (let i = 0; i < 4; i++) {
      const [u, r] = pair("search_knowledge", true, 500);
      items.push(u, r);
    }
    const [u, r] = pair("search_knowledge", false, 500);
    items.push(u, r);
    const summary = summarizeToolSegment(items);
    assert.ok(summary.includes("重试"), `S2 FAIL: 有失败步时 summary 应含「重试」，实际: ${summary}`);
    assert.ok(summary.includes("4"), `S2 FAIL: summary 应含失败次数 4，实际: ${summary}`);
  }

  // ── S3: 总时长 ≥3s → 附加时长 ──
  {
    const items: SegmentTimelineItem[] = [];
    const [u, r] = pair("read_document", false, 14000); // 14s
    items.push(u, r);
    const summary = summarizeToolSegment(items);
    assert.ok(summary.includes("14s") || summary.includes("14"), `S3 FAIL: 总时长 ≥3s 应附加时长，实际: ${summary}`);
  }

  // ── S4: 总时长 <3s → 不附加时长 ──
  {
    const items: SegmentTimelineItem[] = [];
    const [u, r] = pair("read_file", false, 1000);
    items.push(u, r);
    const summary = summarizeToolSegment(items);
    // 不含 "s" 时长标注（或不含数字+s 格式）
    assert.ok(!summary.match(/\d+s/), `S4 FAIL: 总时长 <3s 不应附加时长，实际: ${summary}`);
  }

  // ── S5: 空数组 → 不崩溃 ──
  {
    const summary = summarizeToolSegment([]);
    assert.equal(typeof summary, "string", "S5 FAIL: 空数组应返回字符串");
  }

  // ── S6: 摘要携带对象(renderer 文案「动词：对象」的对象部分,去重取前 2) ──
  {
    const items: SegmentTimelineItem[] = [];
    for (const f of ["测试单据A.pdf", "测试单据B.pdf", "测试单据C.jpg"]) {
      const u: SegmentTimelineItem = { id: `u-${f}`, event: { type: "tool_use", name: "read_document", id: `u-${f}`, input: { filePath: `/tmp/${f}` } }, createdAt: Date.now() };
      const r: SegmentTimelineItem = { id: `r-${f}`, event: { type: "tool_result", name: "read_document", isError: false, toolUseId: `u-${f}`, durationMs: 500 }, createdAt: Date.now() };
      items.push(u, r);
    }
    const summary = summarizeToolSegment(items);
    assert.ok(summary.includes("×3"), `S6 FAIL: 应含步数,实际: ${summary}`);
    assert.ok(summary.includes("："), `S6 FAIL: 应含对象分隔冒号,实际: ${summary}`);
    assert.ok(summary.includes("测试单据A") , `S6 FAIL: 应含首个对象名,实际: ${summary}`);
    assert.ok(!summary.includes("测试单据C"), `S6 FAIL: 只取前 2 个对象,实际: ${summary}`);
  }

  // ── S7: 混合工具组不再冒用占比最高工具的名字 ──
  {
    // 三种工具各一步 → 动词列举,步数=种类数时省略 ×N
    const mixed: SegmentTimelineItem[] = [];
    for (const name of ["Skill", "run_python", "search_knowledge"]) {
      const [u, r] = pair(name, false); mixed.push(u, r);
    }
    const s1 = summarizeToolSegment(mixed);
    assert.ok(s1.includes("、"), `S7 FAIL: 混合组应列举动词,实际: ${s1}`);
    assert.ok(!s1.includes("×3"), `S7 FAIL: 步数=种类数时不重复 ×N,实际: ${s1}`);
    assert.ok(!/：/.test(s1), `S7 FAIL: 混合组不给对象列表(不同动词的对象混列误导),实际: ${s1}`);

    // 超过 3 种 → 首动词 + 等 ×N
    const many: SegmentTimelineItem[] = [];
    for (const name of ["Skill", "run_python", "search_knowledge", "WebSearch", "Edit"]) {
      const [u, r] = pair(name, false); many.push(u, r);
    }
    const s2 = summarizeToolSegment(many);
    assert.ok(s2.includes("等") && s2.includes("×5"), `S7 FAIL: >3 种应「首动词 等 ×N」,实际: ${s2}`);

    // 同工具多步:行为不变(仍带 ×N 与对象)
    const homo: SegmentTimelineItem[] = [];
    for (let k = 0; k < 3; k++) { const [u, r] = pair("search_knowledge", false); homo.push(u, r); }
    const s3 = summarizeToolSegment(homo);
    assert.ok(s3.includes("×3"), `S7 FAIL: 同工具组保持 ×N,实际: ${s3}`);
  }

  console.log("summarize-tool-segment: all checks passed ✓");
})();
