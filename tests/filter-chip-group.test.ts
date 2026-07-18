import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

const sharedPath = "app/shared/filter-chip-group.tsx";
assert.ok(existsSync(path.join(ROOT, sharedPath)), "筛选项应收敛到共享 FilterChipGroup");

const shared = src(sharedPath);
assert.match(shared, /ToggleGroup/, "FilterChipGroup 应基于 shadcn ToggleGroup");
assert.match(shared, /type="single"/, "筛选项应保持单选语义");

for (const file of ["app/knowledge/page.tsx", "app/skills/skills-manager.tsx"]) {
  const source = src(file);
  assert.match(source, /FilterChipGroup/, `${file} 应使用共享筛选组件`);
}
assert.doesNotMatch(src("app/knowledge/page.tsx"), /rounded-full border text-meta font-medium/, "知识库不应保留旧的黑色胶囊筛选样式");

const agentPage = src("app/agents/[roleId]/page.tsx");
assert.match(agentPage, /TabsList/, "智能体页应使用 shadcn TabsList");
assert.match(agentPage, /variant="line"/, "智能体页应保留下划线页签样式");

assert.match(src("docs/ui-conventions.md"), /FilterChipGroup/, "UI 约定应记录页签与筛选的语义边界");

console.log("filter chip group contract tests passed");
