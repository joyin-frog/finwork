import type { ArtifactRef } from "@/lib/artifacts/contracts";
import { ArtifactStore } from "@/lib/artifacts/store";

export type LazyOutput = { kind: "inline"; value: unknown; bytes: number } | { kind: "artifact"; artifact: ArtifactRef; preview: string; bytes: number; truncated: true };
export class OutputSpool {
  constructor(readonly store: ArtifactStore, readonly thresholdBytes = 64 * 1024, readonly previewBytes = 4096) {}
  write(value: unknown, context: { runId: string; caseId?: string; capabilityId: string; logicalName?: string }): LazyOutput {
    const json = JSON.stringify(value); const bytes = Buffer.byteLength(json);
    if (bytes <= this.thresholdBytes) return { kind: "inline", value, bytes };
    const artifact = this.store.put({ kind: "tool_output", logicalName: context.logicalName ?? `${context.capabilityId}-output.json`, ownerCaseId: context.caseId, classification: "internal", retention: {}, mediaType: "application/json", producer: { runId: context.runId, capabilityId: context.capabilityId }, metadata: { lazy: true, bytes }, content: new TextEncoder().encode(json), state: "candidate" });
    this.store.addRef(artifact.versionId, "case_output", context.caseId ?? context.runId);
    return { kind: "artifact", artifact, preview: json.slice(0, this.previewBytes), bytes, truncated: true };
  }
  readWindow(versionId: string, offset: number, length: number): { text: string; offset: number; nextOffset: number | null } {
    if (offset < 0 || length < 1 || length > this.previewBytes) throw new Error("window exceeds prompt retrieval budget");
    const bytes = this.store.read(versionId); const end = Math.min(bytes.byteLength, offset + length);
    return { text: new TextDecoder().decode(bytes.slice(offset, end)), offset, nextOffset: end < bytes.byteLength ? end : null };
  }
}
