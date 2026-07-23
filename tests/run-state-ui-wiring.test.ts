/**
 * CR-R2 UI 接线契约：横幅 / 质量徽标 / chat-page 消费权威 Run。
 * 无 DOM 栈，用源码断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const page = read("app/chat/chat-page.tsx");
assert.match(page, /RunStatusBanner/, "chat-page 应渲染 RunStatusBanner");
assert.match(page, /useRunStatus/, "chat-page 应拉取权威 Run");
assert.match(page, /qualityForFile/, "chat-page 应把质量态传给 AssistantTurn");
assert.match(page, /canShowFileTaskSuccess/, "文件任务成功应用 CompletionGate 条件");

const turn = read("app/chat/components/assistant-turn.tsx");
assert.match(turn, /qualityForFile/, "AssistantTurn 应接受 qualityForFile");
assert.match(turn, /qualityState=\{/, "OpenableFileRow 应收到 qualityState");

const row = read("app/chat/chat-file-browser.tsx");
assert.match(row, /AttachmentQualityBadge/, "OpenableFileRow 应渲染质量徽标");

const banner = read("app/chat/components/run-status-banner.tsx");
assert.match(banner, /runStatusLabel/, "横幅文案走 run-status-labels");

const stream = read("app/shared/chat-stream.tsx");
assert.match(stream, /\/api\/agent\/runs\/.*\/stop/, "stopTurn 应调用 stop API");
assert.match(stream, /runId/, "StreamTurn 应持有 runId");

console.log("run-state-ui-wiring: all checks passed ✓");
