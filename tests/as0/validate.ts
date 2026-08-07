import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildFinanceMcpServers } from "@/lib/agent/mcp-tools";
import type { GoldenManifest } from "./types";

function aliases(value: string): string[] {
  return value.split("|");
}

async function main() {
  const repoRoot = process.cwd();
  const manifestPath = path.join(repoRoot, "docs/spec/fixtures/as0-golden-tasks.v1.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as GoldenManifest;
  const fixtureRoot = path.resolve(path.dirname(manifestPath), manifest.fixtureRoot);
  const errors: string[] = [];
  const assert = (condition: unknown, message: string) => {
    if (!condition) errors.push(message);
  };
  const referencedFixture = (relativePath: string) => path.resolve(fixtureRoot, relativePath);

  const capturedTools: Array<{ name: string }> = [];
  const sdk = {
    tool(name: string) {
      capturedTools.push({ name });
      return { name };
    },
    createSdkMcpServer<T>(server: T): T {
      return server;
    },
  } as unknown as Parameters<typeof buildFinanceMcpServers>[0];
  await buildFinanceMcpServers(sdk, path.join(repoRoot, ".as0-output"));

  const productionTools = new Set(capturedTools.map((tool) => tool.name));
  const builtInTools = new Set(["Read", "Glob", "Grep", "AskUserQuestion", "WebSearch", "WebFetch", "Monitor", "Write", "Edit", "MultiEdit", "Bash", "Skill"]);
  const knownTools = new Set([...productionTools, ...builtInTools]);
  const skillRoot = path.join(repoRoot, "agent-skills/skills");
  const knownSkills = new Set(
    readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(skillRoot, entry.name, "SKILL.md")))
      .map((entry) => entry.name),
  );

  assert(manifest.version === 1, "manifest.version 必须为 1");
  assert(manifest.tasks.length === 20, `任务数应为 20，实际为 ${manifest.tasks.length}`);
  assert(existsSync(fixtureRoot), `fixtureRoot 不存在：${fixtureRoot}`);

  const ids = new Set<string>();
  for (const task of manifest.tasks) {
    assert(/^AS0-\d{2}$/.test(task.id), `${task.id}: id 格式错误`);
    assert(!ids.has(task.id), `${task.id}: id 重复`);
    ids.add(task.id);
    assert(task.turns.length > 0, `${task.id}: turns 不能为空`);
    assert(task.expected.assertions.length > 0, `${task.id}: assertions 不能为空`);

    for (const skillExpression of task.expected.skills) {
      for (const skill of aliases(skillExpression)) {
        assert(knownSkills.has(skill), `${task.id}: 未知 Skill ${skill}`);
      }
    }

    const toolRefs = [
      ...(task.expected.firstToolOneOf ?? []),
      ...task.expected.requiredTools,
      ...task.expected.forbiddenTools,
    ];
    for (const ref of toolRefs) {
      if (ref === "*") continue;
      for (const tool of aliases(ref)) {
        assert(knownTools.has(tool), `${task.id}: 未知工具 ${tool}`);
      }
    }

    for (const turn of task.turns) {
      for (const attachment of turn.attachments ?? []) {
        assert(existsSync(referencedFixture(attachment)), `${task.id}: 附件不存在 ${attachment}`);
      }
    }
    for (const document of task.setup?.knowledgeDocuments ?? []) {
      assert(existsSync(referencedFixture(document)), `${task.id}: 知识库 fixture 不存在 ${document}`);
    }
    if (task.setup?.businessSeed) {
      assert(existsSync(referencedFixture(task.setup.businessSeed)), `${task.id}: business seed 不存在 ${task.setup.businessSeed}`);
    }
    if (task.expected.delivery?.required) {
      assert(task.expected.delivery.mimeTypes.length > 0, `${task.id}: required delivery 缺少 mimeTypes`);
      assert(
        task.expected.requiredTools.includes("finalize_deliverable"),
        `${task.id}: required delivery 必须要求 finalize_deliverable`,
      );
    }
  }

  for (let number = 1; number <= 20; number++) {
    const expectedId = `AS0-${String(number).padStart(2, "0")}`;
    assert(ids.has(expectedId), `缺少任务 ${expectedId}`);
  }

  if (errors.length > 0) {
    console.error(`AS0 manifest validation failed (${errors.length})`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        tasks: manifest.tasks.length,
        fixtures: readdirSync(fixtureRoot).length,
        skills: knownSkills.size,
        productionTools: productionTools.size,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
