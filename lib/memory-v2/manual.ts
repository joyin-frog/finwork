import { sha256Json } from "@/lib/capability/hash";
import type { MemoryRecordV2 } from "./contracts";

export type ManualMemoryContent = {
  summary: string;
  topic: string;
};

function normalizeTopic(topic: string): string {
  return topic.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function createManualMemoryConflictKey(
  kind: MemoryRecordV2["kind"],
  topic: string,
): string {
  const normalized = normalizeTopic(topic);
  if (!normalized) throw new Error("memory topic must not be empty");
  return `manual:${kind}:${sha256Json(normalized).slice(0, 32)}`;
}

export function createManualMemoryContent(topic: string, summary: string): ManualMemoryContent {
  const normalizedTopic = topic.replace(/\s+/g, " ").trim();
  const normalizedSummary = summary.trim();
  if (!normalizedTopic) throw new Error("memory topic must not be empty");
  if (!normalizedSummary) throw new Error("memory content must not be empty");
  return { topic: normalizedTopic, summary: normalizedSummary };
}

export function readManualMemoryContent(content: MemoryRecordV2["content"]): ManualMemoryContent {
  if (
    content
    && typeof content === "object"
    && !Array.isArray(content)
    && typeof content.summary === "string"
  ) {
    return {
      topic: typeof content.topic === "string" && content.topic.trim()
        ? content.topic.trim()
        : "未命名记忆",
      summary: content.summary.trim(),
    };
  }
  return {
    topic: "未命名记忆",
    summary: typeof content === "string" ? content.trim() : JSON.stringify(content),
  };
}

export function correctManualMemoryContent(
  current: MemoryRecordV2["content"],
  summary: string,
): MemoryRecordV2["content"] {
  const normalized = summary.trim();
  if (!normalized) throw new Error("memory content must not be empty");
  if (
    current
    && typeof current === "object"
    && !Array.isArray(current)
    && typeof current.topic === "string"
    && current.topic.trim()
  ) {
    return { ...current, summary: normalized };
  }
  return normalized;
}
