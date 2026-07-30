import type { ZodRawShape } from "zod/v4";
import { getToolRiskLevel, type ToolRiskLevel } from "./registry";

export type FinanceToolDefinition = {
  id: string;
  name: string;
  namespace: "finance_worker" | "kingdee_worker";
  description: string;
  schema: ZodRawShape;
  handler: FinanceToolHandler;
  riskLevel: ToolRiskLevel;
};

export type FinanceToolExecutionContext = {
  signal?: AbortSignal;
};

export type FinanceToolHandler = (
  args: Record<string, unknown>,
  context?: FinanceToolExecutionContext,
) => Promise<unknown> | unknown;

type ToolFactoryLike = {
  tool: (
    name: string,
    description: string,
    schema: ZodRawShape,
    handler: FinanceToolHandler,
  ) => unknown;
};

/**
 * Executes existing tool factories against a neutral collector. No handler is
 * copied and no runtime SDK is involved.
 */
export function createFinanceToolCollector(
  namespace: FinanceToolDefinition["namespace"],
): { sdk: ToolFactoryLike; definitions: FinanceToolDefinition[] } {
  const definitions: FinanceToolDefinition[] = [];
  const sdk: ToolFactoryLike = {
    tool(name, description, schema, handler) {
      const id = `mcp__${namespace}__${name}`;
      const definition: FinanceToolDefinition = {
        id,
        name,
        namespace,
        description,
        schema,
        handler,
        riskLevel: getToolRiskLevel(id),
      };
      definitions.push(definition);
      return definition;
    },
  };
  return { sdk, definitions };
}
