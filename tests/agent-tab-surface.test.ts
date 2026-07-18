import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

export const agentTabSurfaceTestPromise = (async () => {
  const componentPath = "app/agents/agent-tab-surface.tsx";
  assert.ok(existsSync(path.join(root, componentPath)), "智能体页签应有共享 AgentTabSurface 画布组件");

  const component = read(componentPath);
  assert.match(component, /<Surface\b/, "页签画布应基于语义 Surface");
  assert.match(component, /level="card"/, "页签画布应使用卡片层级");
  assert.match(component, /edge="hairline"/, "页签画布应有稳定边界");
  assert.match(component, /shape="card"/, "页签画布外形应由风格 token 控制");
  assert.match(component, /Omit<ComponentProps<typeof Surface>/, "业务页签不应覆盖画布的层级、边界或外形");

  const page = read("app/agents/[roleId]/page.tsx");
  const work = read("app/agents/[roleId]/workspace-work-tab.tsx");
  assert.ok((page.match(/<AgentTabSurface\b/g) ?? []).length >= 3, "记忆、相关对话、概况应复用页签画布");
  assert.match(work, /<AgentTabSurface\b/, "工作页签应复用同一个页签画布");

  const conventions = read("docs/ui-conventions.md");
  assert.match(conventions, /页签内容画布/, "UI 约定应记录页签内容画布的设计语言");
  assert.match(conventions, /AgentTabSurface/, "UI 约定应指向统一实现组件");

  console.log("agent-tab-surface: all agent tabs share one content canvas ✓");
})();
