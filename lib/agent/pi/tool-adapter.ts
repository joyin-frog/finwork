import { z } from "zod/v4";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@earendil-works/pi-ai";
import type { FinanceToolDefinition } from "@/lib/agent/tools/finance-definition";
import type { FinanceToolAuthorization } from "@/lib/agent/tools/authorize";
import type { FinanceToolRuntime } from "@/lib/agent/tools/capability-runtime";

type LegacyToolResult = {
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

/**
 * Converts the neutral catalog to session-scoped Pi custom tools.
 *
 * JSON Schema is derived for model visibility only. Zod is still evaluated
 * immediately before the single existing handler, so transforms/refinements
 * do not become a second source of truth.
 */
export function createPiFinanceTools(
  definitions: FinanceToolDefinition[],
  authorize: FinanceToolAuthorization,
  runtime?: FinanceToolRuntime,
): ToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.id,
    label: definition.name,
    description: definition.description,
    parameters: z.toJSONSchema(z.object(definition.schema), {
      target: "draft-7",
      unrepresentable: "any",
    }) as TSchema,
    async execute(_toolCallId, rawArgs, signal) {
      const args = await z.object(definition.schema).parseAsync(rawArgs);
      await authorize(definition, args, signal);
      const startedAt = Date.now();
      let raw: unknown;
      try {
        raw = runtime
          ? await runtime.execute(definition, args, signal)
          : await definition.handler(args, { signal });
      } catch (error) {
        await authorize.after(
          definition,
          args,
          error instanceof Error ? error.message : String(error),
          true,
          Date.now() - startedAt,
        );
        throw error;
      }
      const result = normalizeLegacyToolResult(raw);
      const resultText = textContent(result.content);
      await authorize.after(
        definition,
        args,
        resultText,
        result.isError,
        Date.now() - startedAt,
      );
      if (result.isError) {
        throw new Error(resultText || `${definition.id} failed`);
      }
      return {
        content: result.content,
        details: result.details,
      };
    },
  }));
}

function textContent(
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
): string {
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function normalizeLegacyToolResult(raw: unknown): {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: unknown;
  isError: boolean;
} {
  const result = (raw ?? {}) as LegacyToolResult;
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const item of result.content ?? []) {
    if (item.type === "image" && item.data && item.mimeType) {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
      continue;
    }
    if (typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(raw ?? null) });
  }
  return {
    content,
    details: result.structuredContent ?? raw,
    isError: result.isError === true,
  };
}
