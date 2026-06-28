import { execSync } from "node:child_process";

// Ensure the sandbox app-data dir exists and carries the real gateway key before the UI boots.
export default function globalSetup() {
  execSync("node scripts/loop/sandbox-env.mjs", { stdio: "inherit" });
}
