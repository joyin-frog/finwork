import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { getAppDataDir, getProjectRoot } from "@/lib/runtime/paths";
import { buildFinanceToolDefinitions } from "@/lib/agent/mcp-tools";
import { createFinanceToolAuthorizer } from "@/lib/agent/tools/authorize";
import { createPiFinanceTools } from "@/lib/agent/pi/tool-adapter";
import { createFinworkPiResourceLoader } from "@/lib/agent/pi/resource-loader";
import { runPiAgent } from "@/lib/agent/pi/agent-service";

export type PiPackagedPreflightResult = {
  serviceLoaded: boolean;
  piEsmLoaded: boolean;
  toolCount: number;
  resourceLoaderLoaded: boolean;
  controlledSessionDir: boolean;
};

/** 无网络、无凭证的 packaged smoke；只验证产物发现性和受控目录。 */
export async function runPiPackagedPreflight(): Promise<PiPackagedPreflightResult> {
  const root = mkdtempSync(path.join(getAppDataDir(), "pi-preflight-"));
  const sessionRoot = path.join(root, "sessions");
  const agentDir = path.join(root, "agent");
  mkdirSync(sessionRoot, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  try {
    const { SessionManager, SettingsManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const manager = SessionManager.create(getProjectRoot(), sessionRoot);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 8_192 },
      retry: { enabled: false },
    });
    const loader = await createFinworkPiResourceLoader({
      cwd: getProjectRoot(),
      agentDir,
      settingsManager,
      systemPrompt: "Finwork Pi packaged preflight",
    });
    const definitions = buildFinanceToolDefinitions(path.join(root, "output"));
    const tools = createPiFinanceTools(
      definitions,
      createFinanceToolAuthorizer({ outputDir: path.join(root, "output") }),
    );
    return {
      serviceLoaded: typeof runPiAgent === "function",
      piEsmLoaded: typeof SessionManager.create === "function",
      toolCount: tools.length,
      resourceLoaderLoaded: loader.getSkills().skills.length >= 0,
      controlledSessionDir:
        realpathSync(manager.getSessionDir()) === realpathSync(sessionRoot) &&
        !manager.usesDefaultSessionDir(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
