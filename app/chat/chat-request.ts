import type { AgentEvent, ChatAttachment, Conversation, GeneratedAttachment, Message, ModelTier, ReferencedFile, SkillRef } from "@/app/chat/chat-types";

export async function submitAgentRequest(params: {
  messages: Message[];
  conversationId: number | null;
  attachments: ChatAttachment[];
  referencedAttachments: ReferencedFile[];
  referencedSkills?: SkillRef[];
  modelTier?: ModelTier;
  signal: AbortSignal;
}) {
  const { messages, conversationId, attachments, referencedAttachments, referencedSkills, modelTier, signal } = params;
  const refAgentAttachments = referencedAttachments.map((file) => ({
    name: file.name,
    mimeType: file.mimeType,
    size: file.sizeBytes,
    dataUrl: "",
    storagePath: file.storagePath
  }));
  // 后端只需技能名;tier 为 fast|reasoning(后端缺省按 fast 处理)。
  const skillNames = (referencedSkills ?? []).map((s) => s.name);
  const tier = modelTier;

  if (attachments.length) {
    const formData = new FormData();
    formData.append("messages", JSON.stringify(messages));
    if (conversationId) formData.append("conversationId", String(conversationId));
    for (const attachment of attachments) {
      const file = dataUrlToFile(attachment);
      if (file) formData.append("files", file, attachment.name);
    }
    if (refAgentAttachments.length) {
      formData.append("referencedAttachments", JSON.stringify(refAgentAttachments));
    }
    if (skillNames.length) formData.append("referencedSkills", JSON.stringify(skillNames));
    if (tier) formData.append("modelTier", tier);
    return fetch("/api/agent/query", { method: "POST", body: formData, signal });
  }

  return fetch("/api/agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, messages, attachments: refAgentAttachments, referencedSkills: skillNames, modelTier: tier }),
    signal
  });
}

export function buildUserContent(text: string, attachments: ChatAttachment[], references: ReferencedFile[]) {
  if (text.trim()) return text.trim();
  if (attachments.length || references.length) return "请分析这些文件。";
  return "";
}

export async function readAttachment(file: File): Promise<ChatAttachment> {
  const [dataUrl, text] = await Promise.all([readAsDataUrl(file), shouldReadAsText(file) ? readAsText(file) : undefined]);
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
    name: file.name || "clipboard-file",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    dataUrl,
    text
  };
}

export function shouldReadAsText(file: File) {
  return file.size <= 300_000 && (file.type.startsWith("text/") || /\.(csv|json|md|txt|log|xml|html)$/i.test(file.name));
}

export function getClipboardFiles(data: DataTransfer) {
  const directFiles = Array.from(data.files);
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  const byFingerprint = new Map<string, File>();
  for (const file of [...directFiles, ...itemFiles]) {
    byFingerprint.set(`${file.name}-${file.size}-${file.lastModified}-${file.type}`, file);
  }
  return Array.from(byFingerprint.values());
}

export function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function readAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export type SSECallbacks = {
  onChunk: (text: string) => void;
  onAgentEvent: (event: AgentEvent) => void;
  onMeta?: (conversationId: number) => void;
  /** agent 提炼标题落定后由服务端推来(done 之后、关流之前);更新标题单一源,header 与侧栏同步。 */
  onTitle?: (conversationId: number, title: string) => void;
  onDone: (payload: { conversationId?: number; conversation?: Conversation; generatedAttachments?: GeneratedAttachment[] }) => void | Promise<void>;
  /** 回合未完成(如步数超限):已完成的部分已落库,带回更新后的会话+产物+原因,前端按"已完成态"展示并提示可继续。 */
  onIncomplete?: (payload: { conversationId?: number; conversation?: Conversation; generatedAttachments?: GeneratedAttachment[]; message?: string }) => void | Promise<void>;
};

/** 单条 SSE 数据帧的分发(纯函数,便于测试)。返回是否已识别处理。 */
export async function dispatchSSEEvent(
  event: {
    type: string;
    content?: string;
    text?: string;
    event?: AgentEvent;
    questionId?: string;
    question?: unknown;
    answer?: string;
    conversationId?: number;
    conversation?: Conversation;
    generatedAttachments?: GeneratedAttachment[];
    message?: string;
    title?: string;
  },
  callbacks: SSECallbacks
): Promise<boolean> {
  if (event.type === "chunk" && event.content) { callbacks.onChunk(event.content); return true; }
  if (event.type === "agent_event" && event.event) { callbacks.onAgentEvent(event.event); return true; }
  if (event.type === "meta" && typeof event.conversationId === "number") { callbacks.onMeta?.(event.conversationId); return true; }
  if (event.type === "ask_user" && event.questionId && event.question) {
    callbacks.onAgentEvent({ type: "ask_user", questionId: event.questionId, question: event.question as Extract<AgentEvent, { type: "ask_user" }>["question"] });
    return true;
  }
  if (event.type === "ask_user_answered" && event.questionId) {
    callbacks.onAgentEvent({ type: "ask_user_answered", questionId: event.questionId, answer: event.answer ?? "" });
    return true;
  }
  if (event.type === "title" && typeof event.conversationId === "number" && typeof event.title === "string") {
    callbacks.onTitle?.(event.conversationId, event.title);
    return true;
  }
  if (event.type === "done") { await callbacks.onDone(event); return true; }
  if (event.type === "incomplete") { await callbacks.onIncomplete?.(event); return true; }
  if (event.type === "error") throw new Error(event.message ?? "Agent stream failed");
  return false;
}

export async function readSSEStream(response: Response, callbacks: SSECallbacks) {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        await dispatchSSEEvent(JSON.parse(line.slice(6)), callbacks);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function dataUrlToFile(attachment: ChatAttachment): File | null {
  try {
    const [header, data] = attachment.dataUrl.split(",", 2);
    if (!data) return null;
    const mimeType = header.split(":")[1]?.split(";")[0] ?? "application/octet-stream";
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], attachment.name, { type: mimeType });
  } catch {
    return null;
  }
}
