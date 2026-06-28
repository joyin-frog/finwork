import assert from "node:assert/strict";
import { ALL_GOLDEN_CASES } from "./golden/cases.ts";
import { TOOL_REGISTRY } from "../lib/agent/tools/registry.ts";

// WP1 / AC1.1: golden eval 里断言的每个工具名都必须能匹配到一个真实注册工具。
// golden 评分器(tests/golden/run.ts)用 `actualToolCall.includes(expectedName)` 做子串匹配,
// 所以"有效"的定义 = 存在某个注册工具名 R 使得 R.includes(expectedName)。
// 否则:expected_tool_calls_loose 永远拿不到分(假红),must_not_call 永远不被触发(假绿)。
export const goldenToolNamesTestPromise = (async () => {
  const registryNames = TOOL_REGISTRY.map((t) => t.name);
  const matchesRealTool = (name: string) => registryNames.some((r) => r.includes(name));

  const offenders: string[] = [];
  for (const gc of ALL_GOLDEN_CASES) {
    // expected_tool_calls_loose 支持 "a|b|c" = 任选其一(对齐评分器 run.ts:177 的 t.split("|").some(...)),
    // 因此逐个备选校验,而不是把整条 "a|b|c" 当成一个工具名。
    for (const entry of gc.expectations.expected_tool_calls_loose ?? []) {
      for (const alt of entry.split("|")) {
        if (!matchesRealTool(alt)) offenders.push(`${gc.id} (loose): "${alt}"`);
      }
    }
    // must_not_call 评分器(run.ts:184)不拆 |,整条子串匹配:含 | 永远命中不了→假绿,直接判违规。
    for (const name of gc.expectations.must_not_call ?? []) {
      if (name.includes("|")) offenders.push(`${gc.id} (must_not_call 含 |,评分器不拆→假绿): "${name}"`);
      else if (!matchesRealTool(name)) offenders.push(`${gc.id} (must_not_call): "${name}"`);
    }
  }

  assert.equal(
    offenders.length,
    0,
    `AC1.1 FAIL: golden cases 引用了不存在的工具名(改不到真实工具→假红/假绿):\n  ${offenders.join("\n  ")}`
  );

  // 防回归:明确钉死几个曾经漂移的幽灵名不得再出现
  for (const ghost of ["search_knowledge_base", "save_memory", "recall_memory", "forget_memory"]) {
    assert.ok(!matchesRealTool(ghost), `AC1.1 FAIL: 幽灵工具名 ${ghost} 又能匹配了?注册表异常`);
    const reappeared = ALL_GOLDEN_CASES.some((gc) =>
      [...(gc.expectations.expected_tool_calls_loose ?? []), ...(gc.expectations.must_not_call ?? [])].includes(ghost)
    );
    assert.ok(!reappeared, `AC1.1 FAIL: 幽灵工具名 ${ghost} 重新出现在 golden cases`);
  }

  console.log(`golden-tool-names: all ${ALL_GOLDEN_CASES.length} cases reference only real tools ✓`);
})();
