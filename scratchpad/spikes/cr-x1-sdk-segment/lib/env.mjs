import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

export function getSdkPackageJson() {
  return require(path.join(spikeRoot, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"));
}

export function getPlatformInfo() {
  return {
    platform: `${os.platform()} ${os.arch()}`,
    release: os.release(),
    node: process.version,
    cwd: process.cwd(),
    spikeRoot,
    sdkVersion: getSdkPackageJson().version,
    timestamp: new Date().toISOString(),
  };
}

/** Live LLM burns require RUN_LIVE=1 and a real ANTHROPIC_API_KEY. */
export function liveGate() {
  const skipLlm = process.env.SKIP_LLM === "true" || process.env.SKIP_LLM === "1";
  const runLive = process.env.RUN_LIVE === "1" || process.env.RUN_LIVE === "true";
  const key = process.env.ANTHROPIC_API_KEY?.trim() || "";
  const hasRealKey = key.length > 0 && !key.startsWith("sk-noop");
  const allowed = runLive && hasRealKey && !skipLlm;
  return {
    skipLlm,
    runLive,
    hasRealKey,
    allowed,
    reason: allowed
      ? "live enabled"
      : [
          !runLive ? "RUN_LIVE not set (default dry-run)" : null,
          !hasRealKey ? "no real ANTHROPIC_API_KEY" : null,
          skipLlm ? "SKIP_LLM set" : null,
        ]
          .filter(Boolean)
          .join("; "),
  };
}

export function printBanner(experimentId, title) {
  const info = getPlatformInfo();
  const gate = liveGate();
  console.log(`\n=== ${experimentId}: ${title} ===`);
  console.log(`SDK ${info.sdkVersion} | ${info.platform} | Node ${info.node}`);
  console.log(`Live gate: ${gate.allowed ? "OPEN" : "CLOSED"} (${gate.reason})`);
}
