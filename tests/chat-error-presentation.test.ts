import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isRawIncompleteErrorContent } from "../app/chat/components/assistant-turn.tsx";

const ROOT = process.cwd();

export const chatErrorPresentationTestPromise = (async () => {
  const rawError = "Claude Code returned an error result: Invalid API key · Fix external API key";

  assert.equal(
    isRawIncompleteErrorContent("Invalid API key · Fix external API", rawError),
    true,
    "SDK 错误正文是事件错误的子串时不应重复展示"
  );
  assert.equal(
    isRawIncompleteErrorContent("已核对 3 张报销单，剩余 2 张未完成。", rawError),
    false,
    "失败前已经生成的有效中文结果仍应保留"
  );

  const turnErrorSource = readFileSync(path.join(ROOT, "app/chat/turn-error.tsx"), "utf8");
  assert.ok(!turnErrorSource.includes("<details"), "错误卡不应展示原始详情折叠区");
  assert.ok(!turnErrorSource.includes("<pre"), "错误卡不应渲染原始 SDK 错误正文");

  const assistantTurnSource = readFileSync(path.join(ROOT, "app/chat/components/assistant-turn.tsx"), "utf8");
  const retryButton = assistantTurnSource.slice(
    assistantTurnSource.indexOf('aria-label="重试"') - 500,
    assistantTurnSource.indexOf('aria-label="重试"') + 200
  );
  assert.ok(retryButton.includes("msg-toolbar-btn-fade"), "重试按钮应使用消息工具栏淡入样式");
  assert.ok(retryButton.includes("opacity-0") && retryButton.includes("group-hover:opacity-100"), "重试按钮默认隐藏并在 hover 时显示");
  assert.ok(retryButton.includes("group-focus-within:opacity-100"), "键盘聚焦时重试按钮必须可见");

  console.log("chat-error-presentation: all checks passed ✓");
})();
