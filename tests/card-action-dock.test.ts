import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

export const cardActionDockTestPromise = (async () => {
  const dockPath = path.join(root, "app/shared/card-action-dock.tsx");
  assert.ok(existsSync(dockPath), "卡片操作区应有共享 CardActionDock 组件");

  const dock = read("app/shared/card-action-dock.tsx");
  assert.ok(dock.includes("mt-auto"), "操作区应固定吸附卡片底部");
  assert.ok(dock.includes("min-h-7"), "操作区应预留固定高度，避免 hover 时布局跳动");
  assert.ok(dock.includes("group-hover:opacity-100"), "操作区应保留 hover 显示行为");

  for (const file of ["app/skills/skill-card.tsx", "app/shared/resource-card.tsx"]) {
    const source = read(file);
    assert.ok(source.includes("CardActionDock"), `${file} 应复用共享卡片操作区`);
    assert.ok(source.includes("h-full"), `${file} 卡片应撑满网格行，以固定底部操作区`);
  }

  const agentCard = read("app/agents/agent-card.tsx");
  assert.ok(agentCard.includes("flex h-full flex-col"), "智能体卡片应撑满网格行");
  assert.ok(agentCard.includes("mt-auto flex items-center justify-between"), "智能体卡片底部操作行应固定吸附底部");

  console.log("card-action-dock: grid card actions stay anchored ✓");
})();
