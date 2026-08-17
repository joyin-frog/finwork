import type { AgentEvent, ChatAttachment, Conversation, FolderRef, GeneratedAttachment, Message, ModelTier, ReferencedFile, SkillRef } from "@/app/chat/chat-types";
import { contractToLegacyEvents } from "@/lib/agent/runtime-events";
import type { AgentEventEnvelope } from "@/lib/agent/runtime-events";
export { formatFolderPathLine, folderNameFromPath, splitFolderPathLines, FOLDER_PATH_LINE_PREFIX } from "@/app/chat/folder-path";

export async function submitAgentRequest(params: {
  messages: Message[];
  conversationId: number | null;
  attachments: ChatAttachment[];
  referencedAttachments: ReferencedFile[];
  referencedSkills?: SkillRef[];
  folderRefs?: FolderRef[];
  modelTier?: ModelTier;
  /** 专员会话（E 刀）：创建新会话时绑定的角色 id；既有会话忽略此参数（服务端以 DB 为准）。 */
  role?: string;
  signal: AbortSignal;
}) {
  const { messages, conversationId, attachments, referencedAttachments, referencedSkills, folderRefs, modelTier, role, signal } = params;
  const workspaceRootIds = [...new Set((folderRefs ?? []).map((folder) => folder.rootId).filter(Boolean))];
  const managedAgentAttachments = attachments.flatMap((file) => file.assetId ? [{
    assetId: file.assetId,
    versionId: file.versionId,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    dataUrl: "",
  }] : []);
  const pendingUploads = attachments.filter((file) => !file.assetId);
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

  if (pendingUploads.length) {
    const formData = new FormData();
    formData.append("messages", JSON.stringify(messages));
    if (conversationId) formData.append("conversationId", String(conversationId));
    for (const attachment of pendingUploads) {
      const file = dataUrlToFile(attachment);
      if (file) formData.append("files", file, attachment.name);
    }
    if (refAgentAttachments.length) {
      formData.append("referencedAttachments", JSON.stringify(refAgentAttachments));
    }
    if (managedAgentAttachments.length) formData.append("managedAttachments", JSON.stringify(managedAgentAttachments));
    if (skillNames.length) formData.append("referencedSkills", JSON.stringify(skillNames));
    if (tier) formData.append("modelTier", tier);
    if (role) formData.append("role", role);
    if (workspaceRootIds.length) formData.append("workspaceRootIds", JSON.stringify(workspaceRootIds));
    return fetch("/api/agent/query", { method: "POST", body: formData, signal });
  }

  return fetch("/api/agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, messages, attachments: [...managedAgentAttachments, ...refAgentAttachments], referencedSkills: skillNames, workspaceRootIds, modelTier: tier, role }),
    signal
  });
}

export function buildUserContent(text: string, attachments: ChatAttachment[], references: ReferencedFile[]) {
  if (text.trim()) return text.trim();
  if (attachments.length || references.length) return "请分析这些文件。";
  return "";
}

export async function readAttachment(file: File): Promise<ChatAttachment> {
  const form = new FormData();
  form.append("files", file, file.name);
  const response = await fetch("/api/workspace/uploads", { method: "POST", body: form });
  const payload = await response.json() as {
    data?: { assets?: Array<{ assetId: string; versionId: string; name: string; mediaType: string; sizeBytes: number }> };
    error?: string;
  };
  const asset = payload.data?.assets?.[0];
  if (!response.ok || !asset) throw new Error(payload.error ?? "文件上传失败");
  return {
    id: asset.assetId,
    assetId: asset.assetId,
    versionId: asset.versionId,
    name: asset.name,
    mimeType: asset.mediaType,
    size: asset.sizeBytes,
    dataUrl: "",
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
  /** AR2a: instanceId 为子代理实例标识（主对话 = null；历史/未知 = undefined）。 */
  onAgentEvent: (event: AgentEvent, instanceId?: string | null) => void;
  /** conversationId 可选；runId（CR-R2）在 meta / run_started 时下发。 */
  onMeta?: (conversationId: number | null, runId?: string | null) => void;
  /** agent 提炼标题落定后由服务端推来(done 之后、关流之前);更新标题单一源,header 与侧栏同步。 */
  onTitle?: (conversationId: number, title: string) => void;
  onDone: (payload: { conversationId?: number; conversation?: Conversation; generatedAttachments?: GeneratedAttachment[] }) => void | Promise<void>;
  /** 回合未完成(如步数超限):已完成的部分已落库,带回更新后的会话+产物+原因,前端按"已完成态"展示并提示可继续。 */
  onIncomplete?: (payload: { conversationId?: number; conversation?: Conversation; generatedAttachments?: GeneratedAttachment[]; message?: string }) => void | Promise<void>;
};

/** 单条 SSE 数据帧的分发(纯函数,便于测试)。返回是否已识别处理。
 *
 * AR2a 双模：
 *   - 旧帧（type: "chunk" / "agent_event" / "done" / "meta" 等）—— 保持不变；
 *   - 新帧（v:1 AgentEventEnvelope）—— 解包后经 contractToLegacyEvents 翻译，
 *     分发为 onChunk / onAgentEvent / onMeta / onTitle 回调。
 *     run_settled / run_ended 不在此处调 onDone（onDone 由旧 done 帧触发，向前兼容）。
 */
export async function dispatchSSEEvent(
  data: Record<string, unknown>,
  callbacks: SSECallbacks
): Promise<boolean> {
  // ── AR2a 新帧：AgentEventEnvelope（v=1）────────────────────────────────────
  if ((data as { v?: unknown }).v === 1) {
    const envelope = data as unknown as AgentEventEnvelope;
    const { event, instanceId } = envelope;

    // message_delta(text) → onChunk（不走 legacy 路径，避免重复 text 合并）
    if (event.type === "message_delta" && event.channel === "text") {
      callbacks.onChunk(event.delta);
      return true;
    }

    // run_started with conversationId → onMeta；envelope.runId 一并下发
    if (event.type === "run_started") {
      const cid = (event as { conversationId?: unknown }).conversationId;
      callbacks.onMeta?.(
        typeof cid === "number" ? cid : null,
        typeof envelope.runId === "string" ? envelope.runId : null,
      );
      return true;
    }

    // title_updated → onTitle
    if (event.type === "title_updated" && typeof (event as { title?: unknown }).title === "string") {
      const titleEvent = event as { title: string; conversationId?: number | null };
      if (titleEvent.conversationId != null) {
        callbacks.onTitle?.(titleEvent.conversationId, titleEvent.title);
      }
      return true;
    }

    // run_settled / turn_started / message_started / message_completed / queue_updated → 不在此分发
    // 注意：run_ended 按 instanceId 分流（子代理 run_ended 不早退，落入 contractToLegacyEvents）
    if (event.type === "run_settled" || event.type === "turn_started" ||
        event.type === "message_started" || event.type === "message_completed" || event.type === "queue_updated") {
      return true; // consumed（onDone/onIncomplete 由旧帧触发）
    }
    // B1 修复：主对话 run_ended（instanceId=null）静默消耗；子代理 run_ended（instanceId 非空）
    // 落入下方 contractToLegacyEvents，映射为 {type:"subagent", phase:"done"} 送达前端时间线。
    if (event.type === "run_ended" && instanceId == null) {
      return true;
    }

    // 其余新合同事件经 contractToLegacyEvents 翻译后分发
    const legacyEvents = contractToLegacyEvents(envelope);
    for (const legacyEv of legacyEvents) {
      callbacks.onAgentEvent(legacyEv as AgentEvent, instanceId);
    }
    return legacyEvents.length > 0;
  }

  // ── 旧帧（向前兼容路径）────────────────────────────────────────────────────
  const event = data as {
    type: string; content?: string; text?: string; event?: AgentEvent;
    questionId?: string; question?: unknown; answer?: string;
    conversationId?: number; conversation?: Conversation;
    generatedAttachments?: GeneratedAttachment[]; message?: string; title?: string;
    runId?: string;
  };
  if (event.type === "chunk" && event.content) { callbacks.onChunk(event.content); return true; }
  if (event.type === "agent_event" && event.event) { callbacks.onAgentEvent(event.event); return true; }
  if (event.type === "meta") {
    callbacks.onMeta?.(
      typeof event.conversationId === "number" ? event.conversationId : null,
      typeof event.runId === "string" ? event.runId : null,
    );
    return true;
  }
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
      // 流结束时 flush 解码器:TCP 分包可能把多字节 UTF-8 字符切在 chunk 边界,
      // stream 模式下尾部字节缓存在 decoder 里,不 flush 会丢末尾字符、最后一帧解析不出。
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        await dispatchSSEEvent(JSON.parse(line.slice(6)) as Record<string, unknown>, callbacks);
      }
      if (done) break;
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
