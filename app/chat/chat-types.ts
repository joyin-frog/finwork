import type { StoredAgentEvent, StoredChatAttachment } from "@/lib/db/sqlite";
import type { TimelineItem } from "@/app/components/tool-call-step";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import { FOLDER_PATH_LINE_PREFIX } from "@/app/chat/folder-path";

export type ChatMode = "new" | "recent";

export type Message = {
  id?: number;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  imageDataUrls?: string[];
  displayFiles?: DisplayFile[];
  agentEvents?: StoredAgentEvent[];
};

export type DisplayFile = {
  id?: string | number;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storagePath?: string;
  dataUrl?: string;
  text?: string;
};

export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  text?: string;
};

/** 输入框草稿区选中的本地文件夹(展示为专属卡片;发送时写入「文件夹路径:」行给 Agent)。 */
export type FolderRef = {
  id: string;
  path: string;
  name: string;
};

export type ReferencedFile = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
};

/** 输入框里被引用的技能(留在正文里,以 /skillName 高亮呈现);name 为技能机器名,description 供提示。 */
export type SkillRef = {
  name: string;
  description: string;
};

/** 本条消息的模型档位:fast=快速模型(默认),reasoning=推理模型(「深度思考」开)。 */
export type ModelTier = "fast" | "reasoning";

export type GeneratedAttachment = {
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type Conversation = {
  id: number;
  title: string;
  /** 专员会话的角色 id（E 刀）；null/缺省 = 主管会话。 */
  roleId?: string | null;
  messages: Message[];
};

export type AskUserQuestionPayload = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
  // 多题一次下发:非空(>1)时面板渲染为左右切换分页,逐题作答,提交时合并为 JSON。
  questions?: Array<{ question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }>;
  // 高风险工具确认门:confirm 时渲染为确认卡(两按钮,无文本框);缺省为普通提问。
  kind?: "confirm" | "question";
  // 可信任工具为 true 时面板在确认卡里渲染「本次对话不再询问」勾选项。
  trustable?: boolean;
};

/** AR2a: 统一事件合同别名（唯一定义在 lib/agent/runtime-events.ts）。 */
export type AgentEvent = AgentRuntimeEvent;

export type { TimelineItem };

// system 事件用白名单渲染:只显示真正有意义的(目前仅上下文压缩)。
// thinking_tokens / init 等网关噪声一律挡掉,顺带净化已落库的历史会话(getPersistedTimeline 复用本函数)。
// AR2a: 新合同事件（message_delta / run_started / run_settled 等）在 reducer 层已按职责分流，
// 不进此函数的可见检测（它们不经 shouldHideAgentEvent 过滤，而是被 reduceAgentEvent 直接处理）。
const VISIBLE_SYSTEM_SUBTYPES = new Set(["compact_boundary"]);

export function shouldHideAgentEvent(event: AgentEvent) {
  if (event.type !== "system") return false;
  return !VISIBLE_SYSTEM_SUBTYPES.has((event as { subtype?: string }).subtype ?? "");
}

export function getDisplayContent(message: Message) {
  if (message.role !== "user") return message.content;
  return stripAttachmentSummary(message.content).trim();
}

export function stripAttachmentSummary(content: string) {
  const withoutFolders = content
    .split("\n")
    .filter((line) => !line.startsWith(FOLDER_PATH_LINE_PREFIX))
    .join("\n");
  return withoutFolders
    .replace(/\n{0,2}上传文件：[\s\S]*?(?=\n{2,}\S|$)/g, "")
    .replace(/\n{0,2}引用文件：[\s\S]*?(?=\n{2,}\S|$)/g, "")
    .trim();
}

export function getMessageFiles(message: Message, files: StoredChatAttachment[]): DisplayFile[] {
  if (message.displayFiles?.length) return message.displayFiles;
  if (!message.id) return [];
  return files
    .filter((file) => file.messageId === message.id)
    .map((file) => ({
      id: file.id,
      name: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      storagePath: file.storagePath
    }));
}

export function getPersistedTimeline(message: Message): TimelineItem[] {
  return (message.agentEvents ?? [])
    .map((item) => ({ id: String(item.id), event: item.payload as AgentEvent, createdAt: Date.parse(item.createdAt) || 0 }))
    .filter((item) => !shouldHideAgentEvent(item.event as AgentEvent));
}
