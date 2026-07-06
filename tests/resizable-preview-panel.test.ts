/**
 * resizable-preview-panel.test.ts
 *
 * TDD spec for:
 *  1. clampPreviewWidth pure function (真 TDD — 先红后绿)
 *  2. 源码契约: 壳组件装配 + 壳不 import 内容组件 + 三处采纳
 *
 * Run:
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/resizable-preview-panel.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

export const resizablePreviewPanelTestPromise = (async () => {
  // ─── A. clampPreviewWidth 纯函数单测 ──────────────────────────────────────

  const { clampPreviewWidth } = await import("../app/shared/use-preview-resize.ts");

  // A1: 向右拖（deltaX > 0）→ 面板变窄
  {
    const result = clampPreviewWidth({ startW: 600, deltaX: 100, containerW: 1400, listMinW: 300, handleW: 4 });
    // raw = 600 - 100 = 500; max = max(200, 1400-4-300)=1096; clamped = 500
    assert.equal(result, 500, "A1 FAIL: 向右拖应使面板变窄");
  }
  console.log("A1: 向右拖变窄 ✓");

  // A2: 向左拖（deltaX < 0）→ 面板变宽
  {
    const result = clampPreviewWidth({ startW: 600, deltaX: -100, containerW: 1400, listMinW: 300, handleW: 4 });
    // raw = 600 - (-100) = 700; max = 1096; clamped = 700
    assert.equal(result, 700, "A2 FAIL: 向左拖应使面板变宽");
  }
  console.log("A2: 向左拖变宽 ✓");

  // A3: 下限 200（拖到极小值时夹住）
  {
    const result = clampPreviewWidth({ startW: 600, deltaX: 1000, containerW: 1400, listMinW: 300, handleW: 4 });
    // raw = 600 - 1000 = -400; clamped = max(200, ...) = 200
    assert.equal(result, 200, "A3 FAIL: 面板宽度下限应为 200");
  }
  console.log("A3: 下限 200 ✓");

  // A4: 上限 = containerW - handleW - listMinW
  {
    const result = clampPreviewWidth({ startW: 600, deltaX: -2000, containerW: 1400, listMinW: 300, handleW: 4 });
    // raw = 600 - (-2000) = 2600; max = max(200, 1400-4-300)=1096; clamped = 1096
    assert.equal(result, 1096, "A4 FAIL: 面板宽度上限应为 containerW - handleW - listMinW");
  }
  console.log("A4: 上限 = containerW - handleW - listMinW ✓");

  // A5: listMinW 过大导致 max < 200，上限回落到 200
  {
    const result = clampPreviewWidth({ startW: 100, deltaX: -2000, containerW: 500, listMinW: 400, handleW: 4 });
    // max = max(200, 500-4-400) = max(200, 96) = 200; raw = 2100; clamped = 200
    assert.equal(result, 200, "A5 FAIL: listMinW 过大时 max 应回落到 200");
  }
  console.log("A5: listMinW 过大时回落 200 ✓");

  // A6: deltaX=0 → 返回 startW（在夹制范围内）
  {
    const result = clampPreviewWidth({ startW: 600, deltaX: 0, containerW: 1400, listMinW: 300, handleW: 4 });
    assert.equal(result, 600, "A6 FAIL: deltaX=0 应返回 startW（夹制内）");
  }
  console.log("A6: deltaX=0 返回 startW ✓");

  // A7: handleW 是外层参数，不写死 4（验证不同 handleW 值影响结果）
  {
    const result8 = clampPreviewWidth({ startW: 600, deltaX: -2000, containerW: 1400, listMinW: 300, handleW: 8 });
    // max = max(200, 1400-8-300) = 1092
    assert.equal(result8, 1092, "A7 FAIL: handleW 应是参数，不应写死 4");
  }
  console.log("A7: handleW 作为外层参数传入 ✓");

  // ─── B. 壳组件源码契约 ────────────────────────────────────────────────────

  const shellSrc = src("app/shared/resizable-preview-panel.tsx");

  // B1: 壳含 cursor-col-resize（分隔条）
  assert.ok(
    shellSrc.includes("cursor-col-resize"),
    "B1 FAIL: 壳应含 cursor-col-resize 分隔条"
  );
  console.log("B1: 壳含 cursor-col-resize ✓");

  // B2: 壳含 maximized 装配（放大逻辑）
  assert.ok(
    shellSrc.includes("maximized"),
    "B2 FAIL: 壳应含 maximized 装配"
  );
  console.log("B2: 壳含 maximized ✓");

  // B3: 壳含 mainRef 装配
  assert.ok(
    shellSrc.includes("mainRef"),
    "B3 FAIL: 壳应含 mainRef 装配"
  );
  console.log("B3: 壳含 mainRef ✓");

  // B4: 壳不 import 具体内容组件（import 行不含 file-preview-page / knowledge / agent-detail-drawer）
  const shellImportLines = shellSrc.split("\n").filter(l => l.trimStart().startsWith("import "));
  assert.ok(
    !shellImportLines.some(l => l.includes("file-preview-page")),
    "B4a FAIL: 壳 import 行不应含 file-preview-page"
  );
  assert.ok(
    !shellImportLines.some(l => l.includes("knowledge")),
    "B4b FAIL: 壳 import 行不应含 knowledge 内容组件"
  );
  assert.ok(
    !shellImportLines.some(l => l.includes("agent-detail-drawer")),
    "B4c FAIL: 壳 import 行不应含 agent-detail-drawer 内容组件"
  );
  console.log("B4: 壳不 import 内容组件 ✓");

  // B5: 壳有 listMinWidthClass 支持（左列 min-w）
  assert.ok(
    shellSrc.includes("listMinWidthClass"),
    "B5 FAIL: 壳应支持 listMinWidthClass prop"
  );
  console.log("B5: 壳支持 listMinWidthClass ✓");

  // B6: 壳右面板统一用 preview-card-frame（浮起卡片），保证 files/knowledge/智能体三处观感一致。
  //     用户明确要求三处预览外观一致；壳单一来源写死 → 所有消费者同款，无法各自漂移。
  assert.ok(
    shellSrc.includes("preview-card-frame"),
    "B6 FAIL: 壳右面板应统一用 preview-card-frame（三处预览外观必须一致，浮起卡片）"
  );
  console.log("B6: 壳统一 preview-card-frame（三处一致）✓");

  // ─── C. 三处采纳源码契约 ──────────────────────────────────────────────────

  const SHELL_IMPORT = "ResizablePreviewPanel";
  const DIVIDER_CLASS = "cursor-col-resize";

  // C1: files/page.tsx 使用壳
  {
    const filesSrc = src("app/files/page.tsx");
    assert.ok(
      filesSrc.includes(SHELL_IMPORT),
      "C1a FAIL: app/files/page.tsx 应 import 并用 ResizablePreviewPanel"
    );
    // 不再手写分隔条（排除壳文件自身，只检查 files 页）
    assert.ok(
      !filesSrc.includes(DIVIDER_CLASS),
      "C1b FAIL: app/files/page.tsx 不应再手写 cursor-col-resize（已由壳统一管理）"
    );
  }
  console.log("C1: files/page.tsx 采纳壳 ✓");

  // C2: knowledge/page.tsx 使用壳
  {
    const knowledgeSrc = src("app/knowledge/page.tsx");
    assert.ok(
      knowledgeSrc.includes(SHELL_IMPORT),
      "C2a FAIL: app/knowledge/page.tsx 应 import 并用 ResizablePreviewPanel"
    );
    assert.ok(
      !knowledgeSrc.includes(DIVIDER_CLASS),
      "C2b FAIL: app/knowledge/page.tsx 不应再手写 cursor-col-resize"
    );
  }
  console.log("C2: knowledge/page.tsx 采纳壳 ✓");

  // C3: agents/page.tsx 使用壳
  {
    const agentsPageSrc = src("app/agents/page.tsx");
    assert.ok(
      agentsPageSrc.includes(SHELL_IMPORT),
      "C3a FAIL: app/agents/page.tsx 应 import 并用 ResizablePreviewPanel"
    );
    // agents 页不再直接写分隔条（分隔条由壳负责）
    assert.ok(
      !agentsPageSrc.includes(DIVIDER_CLASS),
      "C3b FAIL: app/agents/page.tsx 不应再手写 cursor-col-resize"
    );
  }
  console.log("C3: agents/page.tsx 采纳壳 ✓");

  // C4: agent-detail-drawer.tsx 已删内部分隔条
  {
    const drawerSrc = src("app/agents/agent-detail-drawer.tsx");
    assert.ok(
      !drawerSrc.includes(DIVIDER_CLASS),
      "C4 FAIL: agent-detail-drawer.tsx 应已删除内部 cursor-col-resize 分隔条"
    );
    // 不再有 dragging / onBeginResize props（已由壳负责）
    assert.ok(
      !drawerSrc.includes("onBeginResize"),
      "C4b FAIL: agent-detail-drawer.tsx 应已去掉 onBeginResize prop"
    );
    assert.ok(
      !drawerSrc.includes("dragging"),
      "C4c FAIL: agent-detail-drawer.tsx 应已去掉 dragging prop"
    );
  }
  console.log("C4: agent-detail-drawer.tsx 已删分隔条及相关 props ✓");

  // C5: 智能体抽屉不自己套外框样式（bg-card/border-l/preview-card-frame 都由壳统一给），
  //     否则会与 files/knowledge 观感漂移——用户明确要求三处一致。
  {
    const drawerSrc = src("app/agents/agent-detail-drawer.tsx");
    assert.ok(
      !drawerSrc.includes("border-l") && !drawerSrc.includes("preview-card-frame"),
      "C5 FAIL: agent-detail-drawer.tsx 不应自带外框（border-l/preview-card-frame），外框统一由壳提供"
    );
  }
  console.log("C5: 智能体抽屉外框交给壳统一（三处一致）✓");

  console.log("\nresizable-preview-panel: 全部断言通过 ✓");
})();
