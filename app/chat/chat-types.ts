import type { StoredAgentEvent, StoredChatAttachment } from "@/lib/db/sqlite";
import type { TimelineItem } from "@/app/components/tool-call-step";

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

export type ReferencedFile = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
};

export type GeneratedAttachment = {
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type Conversation = {
  id: number;
  title: string;
  messages: Message[];
};

export type AskUserQuestionPayload = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
};

export type AgentEvent =
  | { type: "system"; subtype?: string; message: string }
  | { type: "text"; content: string }
  | { type: "tool_use"; id?: string; name: string; input?: unknown }
  | { type: "tool_result"; toolUseId?: string; name?: string; content?: string; isError?: boolean; durationMs?: number; structured?: unknown }
  | { type: "ask_user"; questionId: string; question: AskUserQuestionPayload }
  | { type: "ask_user_answered"; questionId: string; answer: string };

export type { TimelineItem };

// system 事件用白名单渲染:只显示真正有意义的(目前仅上下文压缩)。
// init/status 无展示价值;thinking_tokens 等网关噪声此前会渲染成「系统事件:thinking_tokens」刷屏,
// 这里统一挡掉,顺带净化已落库的历史会话(getPersistedTimeline 复用本函数)。
const VISIBLE_SYSTEM_SUBTYPES = new Set(["compact_boundary"]);

export function shouldHideAgentEvent(event: AgentEvent) {
  if (event.type !== "system") return false;
  return !VISIBLE_SYSTEM_SUBTYPES.has(event.subtype ?? "");
}

export function getDisplayContent(message: Message) {
  if (message.role !== "user") return message.content;
  return stripAttachmentSummary(message.content).trim();
}

export function stripAttachmentSummary(content: string) {
  return content
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
