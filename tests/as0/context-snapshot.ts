import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { buildFinanceMcpServers } from "@/lib/agent/mcp-tools";
import { buildSystemPromptParts } from "@/lib/agent/system-prompt";
import { TOOL_REGISTRY } from "@/lib/agent/tools/registry";

type CapturedTool = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function size(value: string) {
  return { chars: Array.from(value).length, bytes: Buffer.byteLength(value, "utf8") };
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).trim();
}

function frontmatterValue(markdown: string, key: string): string {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return (match?.[1] ?? "").replace(/^["']|["']$/g, "");
}

async function main() {
const repoRoot = process.cwd();
const promptParts = buildSystemPromptParts({
  identity: { companyName: "AS0 测试公司", agentName: "小财" },
  roleMode: "tech",
  now: new Date("2026-07-29T09:00:00+08:00"),
  outputDir: "/AS0/OUTPUT",
  memoryMarkdown: "- 预算报表按部门拆分",
  recentNegativeFeedback: ["不要覆盖原始文件"],
  companyProfile: { taxpayerType: "一般纳税人", industry: "软件服务" },
});
const [staticPrompt, runtimeBoundary, dynamicContext] = promptParts;

const skillRoot = path.join(repoRoot, "agent-skills/skills");
const skills = readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const source = path.join(skillRoot, entry.name, "SKILL.md");
    const markdown = readFileSync(source, "utf8");
    const name = frontmatterValue(markdown, "name");
    const description = frontmatterValue(markdown, "description");
    return {
      name,
      source: path.relative(repoRoot, source),
      description,
      descriptionSize: size(description),
      fileSize: size(markdown),
      sha256: sha256(markdown),
    };
  })
  .filter((skill) => skill.name)
  .sort((a, b) => a.name.localeCompare(b.name));

const capturedTools: CapturedTool[] = [];
const sdk = {
  tool(name: string, description: string, schema: z.ZodRawShape) {
    capturedTools.push({ name, description, schema });
    return { name, description, schema };
  },
  createSdkMcpServer<T>(server: T): T {
    return server;
  },
} as unknown as Parameters<typeof buildFinanceMcpServers>[0];
await buildFinanceMcpServers(sdk, "/AS0/OUTPUT");

const registryByBareName = new Map(
  TOOL_REGISTRY.map((tool) => [tool.name.split("__").at(-1) ?? tool.name, tool]),
);
const tools = capturedTools
  .map((tool) => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(z.object(tool.schema)));
    const registry = registryByBareName.get(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      jsonSchema,
      descriptionSize: size(tool.description),
      schemaSize: size(jsonSchema),
      definitionSha256: sha256(`${tool.description}\n${jsonSchema}`),
      riskLevel: registry?.riskLevel ?? "unregistered",
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const skillListing = JSON.stringify(skills.map(({ name, description }) => ({ name, description })));
const toolDefinitions = JSON.stringify(tools.map(({ name, description, jsonSchema, definitionSha256 }) => ({
  name,
  description,
  jsonSchema,
  definitionSha256,
})));
const repositoryPrompt = readFileSync(path.join(repoRoot, "lib/agent/SYSTEM_PROMPT.md"), "utf8");

const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  git: {
    commit: git("rev-parse", "HEAD"),
    dirtyFiles: git("status", "--short").split("\n").filter(Boolean),
  },
  context: {
    staticPrompt: { ...size(staticPrompt), sha256: sha256(staticPrompt) },
    runtimeBoundary: {
      type: typeof runtimeBoundary,
      chars: typeof runtimeBoundary === "string" ? size(runtimeBoundary).chars : null,
      bytes: typeof runtimeBoundary === "string" ? size(runtimeBoundary).bytes : null,
    },
    dynamicContextFixture: { ...size(dynamicContext), sha256: sha256(dynamicContext) },
    repositoryPrompt: { ...size(repositoryPrompt), sha256: sha256(repositoryPrompt) },
    skillListing: { count: skills.length, ...size(skillListing), sha256: sha256(skillListing) },
    toolDefinitions: { count: tools.length, ...size(toolDefinitions), sha256: sha256(toolDefinitions) },
    providerTokens: "unavailable_without_provider_call"
  },
  skills,
  tools,
  registry: {
    total: TOOL_REGISTRY.length,
    builtIn: TOOL_REGISTRY.filter((tool) => tool.category === "builtin").length,
    finance: TOOL_REGISTRY.filter((tool) => tool.category === "finance").length,
    productionToolCount: tools.length,
    productionToolsMissingFromRegistry: tools.filter((tool) => tool.riskLevel === "unregistered").map((tool) => tool.name),
  },
};

console.log(JSON.stringify(snapshot, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
