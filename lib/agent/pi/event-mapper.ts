import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";

export type PiEventTrace = {
  piType: AgentSessionEvent["type"];
  action: "mapped" | "dropped";
  runtimeTypes: AgentRuntimeEvent["type"][];
};

/**
 * Stateful Pi -> Finwork event mapper. Query/UI/DB only see the Finwork
 * contract; Pi event types stop at this file.
 */
export class PiEventMapper {
  private outcome: "completed" | "aborted" | "error" = "completed";

  map(event: AgentSessionEvent): { events: AgentRuntimeEvent[]; trace: PiEventTrace } {
    const mapped = this.mapEvent(event);
    return {
      events: mapped,
      trace: {
        piType: event.type,
        action: mapped.length > 0 ? "mapped" : "dropped",
        runtimeTypes: mapped.map((item) => item.type),
      },
    };
  }

  private mapEvent(event: AgentSessionEvent): AgentRuntimeEvent[] {
    switch (event.type) {
      case "agent_start":
        return [{ type: "run_started" }];
      case "turn_start":
        return [{ type: "turn_started" }];
      case "message_update": {
        const update = event.assistantMessageEvent;
        switch (update.type) {
          case "text_start":
            return [{ type: "message_started", channel: "text" }];
          case "text_delta":
            return [{ type: "message_delta", channel: "text", delta: update.delta }];
          case "text_end":
            return [{ type: "message_completed", channel: "text", content: update.content }];
          case "thinking_start":
            return [{ type: "message_started", channel: "thinking" }];
          case "thinking_delta":
            return [{ type: "message_delta", channel: "thinking", delta: update.delta }];
          case "thinking_end":
            return [{ type: "message_completed", channel: "thinking", content: update.content }];
          case "error":
            this.outcome = update.reason === "aborted" ? "aborted" : "error";
            return [];
          default:
            return [];
        }
      }
      case "tool_execution_start":
        return [{
          type: "tool_started",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          input: event.args,
        }];
      case "tool_execution_update":
        return [{ type: "tool_updated" }];
      case "tool_execution_end":
        return [{
          type: "tool_completed",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          content: toolResultText(event.result),
          structured: event.result?.details,
        }];
      case "compaction_end":
        return event.aborted
          ? []
          : [{
              type: "compaction_completed",
              preTokens: event.result?.tokensBefore,
              postTokens: event.result?.estimatedTokensAfter,
              trigger: event.reason,
            }];
      case "queue_update":
        return [{ type: "queue_updated" }];
      case "agent_end":
        return [{
          type: "run_ended",
          kind: this.outcome === "completed" ? "complete" : "incomplete",
        }];
      case "agent_settled":
        return [{
          type: "run_settled",
          outcome: this.outcome,
        }];
      default:
        // User messages, provider framing, entry persistence, retries and
        // configuration notifications are intentionally not public runtime
        // events. They remain available through the returned trace.
        return [];
    }
  }
}

function toolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((item) =>
      item && typeof item === "object" && (item as { type?: unknown }).type === "text"
        ? [String((item as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
  return text || undefined;
}
