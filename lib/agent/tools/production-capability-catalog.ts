import path from "node:path";
import { buildFinanceToolDefinitions } from "@/lib/agent/mcp-tools";
import { getAppDataDir } from "@/lib/runtime/paths";
import {
  synchronizeFinanceCapabilityCatalog,
  type FinanceCapabilityCatalogSyncResult,
} from "./capability-runtime";

/**
 * Startup authority for the production capability management catalog.
 * Tool factories are collected only; no handler is executed and no run/grant
 * state is created.
 */
export function synchronizeProductionFinanceCapabilityCatalog(): FinanceCapabilityCatalogSyncResult {
  const definitions = buildFinanceToolDefinitions(
    path.join(getAppDataDir(), "capability-catalog"),
  );
  return synchronizeFinanceCapabilityCatalog(definitions);
}
