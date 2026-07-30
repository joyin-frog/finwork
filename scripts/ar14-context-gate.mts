import { Buffer } from "node:buffer";
import { z } from "zod/v4";
import { buildSystemPromptParts } from "../lib/agent/system-prompt.ts";
import { listSkills } from "../lib/agent/skills-store.ts";
import { buildFinanceToolDefinitions } from "../lib/agent/mcp-tools/index.ts";
import { resolveAgentContextPolicy } from "../lib/agent/context-policy.ts";
import type { AgentAttachment, AgentIntent } from "../lib/agent/contracts.ts";

function size(value: string) {
  return { chars: Array.from(value).length, bytes: Buffer.byteLength(value, "utf8") };
}

const prompt = buildSystemPromptParts({
  identity: { companyName: "AR14 测试公司", agentName: "小财" },
  roleMode: "tech",
  now: new Date("2026-07-30T09:00:00+08:00"),
  outputDir: "/AR14/OUTPUT",
  memoryMarkdown: "- 预算报表按部门拆分",
  recentNegativeFeedback: ["不要覆盖原始文件"],
  companyProfile: { taxpayerType: "一般纳税人", industry: "软件服务" },
});
const skills = (await listSkills()).filter((skill) => skill.enabled);
const definitions = buildFinanceToolDefinitions("/AR14/OUTPUT");
const definitionPayload = (items: typeof definitions) => JSON.stringify(items.map((definition) => ({
  name: definition.id,
  description: definition.description,
  parameters: z.toJSONSchema(z.object(definition.schema), {
    target: "draft-7",
    unrepresentable: "any",
  }),
})));
const skillPayload = (names?: string[]) => JSON.stringify(
  skills
    .filter((skill) => !names || names.includes(skill.name))
    .map(({ name, description }) => ({ name, description })),
);

const samples: Array<{
  id: string;
  message: string;
  intent: AgentIntent;
  attachments?: AgentAttachment[];
}> = [
  {
    id: "payroll",
    message: "请根据工资表计算本月个税",
    intent: "tool_task",
    attachments: [{
      name: "工资表.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 1,
      dataUrl: "",
    }],
  },
  { id: "knowledge", message: "公司差旅住宿标准是什么", intent: "rag_qa" },
  { id: "voucher", message: "把这些单据整理成金蝶凭证草稿", intent: "complex_workflow" },
  { id: "unknown", message: "帮我处理这个财务事项", intent: "complex_workflow" },
];

const fullTools = definitionPayload(definitions);
const sampleResults = samples.map((sample) => {
  const policy = resolveAgentContextPolicy({
    messages: [{ role: "user", content: sample.message }],
    attachments: sample.attachments,
    intent: sample.intent,
  });
  const selectedDefinitions = policy.toolIds
    ? definitions.filter((definition) => policy.toolIds!.includes(definition.id))
    : definitions;
  return {
    id: sample.id,
    profiles: policy.profiles,
    skillCount: policy.skillNames?.length ?? skills.length,
    toolCount: selectedDefinitions.length,
    skillListing: size(skillPayload(policy.skillNames)),
    toolDefinitions: size(definitionPayload(selectedDefinitions)),
    fullCatalogFallback: policy.toolIds === undefined,
  };
});

const metrics = {
  staticPrompt: size(prompt[0]),
  dynamicContext: size(prompt[1]),
  runtimeBoundaryRemoved: prompt.length === 2,
  skillListing: size(skillPayload()),
  toolDefinitions: size(fullTools),
  skillCount: skills.length,
  toolCount: definitions.length,
  samples: sampleResults,
};
const assertions = {
  runtimeBoundaryRemoved: metrics.runtimeBoundaryRemoved,
  staticPromptBudget: metrics.staticPrompt.chars <= 1_200,
  skillListingBudget: metrics.skillListing.chars <= 1_800,
  fullCatalogDescriptionBudget: metrics.toolDefinitions.chars <= 52_000,
  fullCatalogStillComplete: metrics.toolCount === 45,
  bundledSkillsStillComplete: metrics.skillCount >= 14,
  payrollNarrowed: sampleResults.find((sample) => sample.id === "payroll")!.toolCount <= 10,
  knowledgeNarrowed: sampleResults.find((sample) => sample.id === "knowledge")!.toolCount === 4,
  voucherNarrowed: sampleResults.find((sample) => sample.id === "voucher")!.toolCount <= 18,
  unknownFallsBack: sampleResults.find((sample) => sample.id === "unknown")!.fullCatalogFallback,
};
const passed = Object.values(assertions).every(Boolean);
console.log(JSON.stringify({ passed, assertions, metrics }, null, 2));
if (!passed) process.exitCode = 1;
