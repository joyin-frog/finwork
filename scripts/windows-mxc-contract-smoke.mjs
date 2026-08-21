import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConfigFromPolicy } from "@microsoft/mxc-sdk";

if (process.platform !== "win32") {
  console.log("windows-mxc-contract-smoke: skipped on non-Windows host");
  process.exit(0);
}

const executable = path.resolve(process.argv[2] ?? "src-tauri/resources/next-server/bin/mxc/wxc-exec.exe");
if (!fs.existsSync(executable)) throw new Error(`packaged wxc-exec.exe missing: ${executable}`);

const probeRun = spawnSync(executable, ["--probe"], { encoding: "utf8", timeout: 10_000 });
if (probeRun.status !== 0) throw new Error(`MXC probe failed: ${probeRun.stderr || probeRun.stdout}`);
const probe = JSON.parse(probeRun.stdout);
if (!probe?.tier) throw new Error("MXC probe returned no isolation tier");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-mxc-contract-"));
try {
  const policy = {
    version: "0.7.0-alpha",
    filesystem: {
      readwritePaths: [work],
      readonlyPaths: [process.env.SystemRoot ?? "C:\\Windows"],
      deniedPaths: [],
      clearPolicyOnExit: true,
    },
    network: { allowOutbound: false, allowLocalNetwork: false },
    ui: { allowWindows: false, clipboard: "none", allowInputInjection: false },
    timeoutMs: 15_000,
  };
  const config = createConfigFromPolicy(policy, "process", "Finwork-MXC-Contract-Smoke");
  config.process = {
    ...(config.process ?? {}),
    commandLine: "cmd.exe /d /s /c \"echo FINWORK_MXC_OK\"",
    cwd: work,
    env: [
      `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`,
      `TEMP=${work}`,
      `TMP=${work}`,
    ],
    timeout: 15_000,
  };
  const payload = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  const dryRun = spawnSync(
    executable,
    ["--config-base64", payload, "--experimental", "--dry-run"],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (dryRun.status !== 0) throw new Error(`MXC official config dry-run failed: ${dryRun.stderr || dryRun.stdout}`);

  if (probe.tier === "base-container") {
    const actual = spawnSync(
      executable,
      ["--config-base64", payload, "--experimental"],
      { encoding: "utf8", timeout: 20_000 },
    );
    if (actual.status !== 0 || !actual.stdout.includes("FINWORK_MXC_OK")) {
      throw new Error(`MXC BaseContainer execution failed: ${actual.stderr || actual.stdout}`);
    }
    console.log("windows-mxc-contract-smoke: official config + BaseContainer execution passed");
  } else {
    console.log(`windows-mxc-contract-smoke: official config passed; host tier=${probe.tier}, product will fail closed`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
