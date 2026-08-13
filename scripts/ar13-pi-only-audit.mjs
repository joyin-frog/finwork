import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const auditDir = await mkdtemp(path.join(tmpdir(), "finwork-ar13-pi-only-"));
const outfile = path.join(auditDir, "pi-runtime.mjs");
const metafile = path.join(auditDir, "meta.json");
const forbidden = [
  ["@anthropic-ai", "claude-agent-sdk"].join("/"),
  ["claude", "adapter"].join("-"),
  ["run", "ClaudeAgent"].join(""),
  ["CLAUDE", "CODE_STREAM"].join("_"),
  ["CLAUDE", "CONFIG_DIR"].join("_"),
  [".claude", "plugin"].join("-"),
];

async function filesUnder(target) {
  try {
    const info = await stat(target);
    if (info.isFile()) return [target];
    if (!info.isDirectory()) return [];
  } catch {
    return [];
  }
  const files = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === "ar13-pi-only-audit.mjs") continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function forbiddenMatches(targets) {
  const matches = [];
  for (const target of targets) {
    for (const file of await filesUnder(path.join(root, target))) {
      const content = await readFile(file, "utf8").catch(() => "");
      for (const token of forbidden) {
        if (content.includes(token)) matches.push(`${path.relative(root, file)}:${token}`);
      }
    }
  }
  return matches;
}

try {
  const build = spawnSync(
    path.join(root, "node_modules", ".bin", "esbuild"),
    [
      "scratchpad/spikes/ar13-pi-only/entry.mts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      `--outfile=${outfile}`,
      `--metafile=${metafile}`,
      "--log-level=warning",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || "esbuild failed");
  const meta = JSON.parse(await readFile(metafile, "utf8"));
  const inputs = Object.keys(meta.inputs);
  const artifact = await readFile(outfile, "utf8");
  const run = spawnSync(process.execPath, [outfile], {
    cwd: auditDir,
    env: {
      ...process.env,
      FINANCE_AGENT_APP_DATA_DIR: path.join(auditDir, "app-data"),
      FINANCE_AGENT_DB_PATH: path.join(auditDir, "isolated.db"),
      FINANCE_AGENT_SECRET_BACKEND: "file",
      FINANCE_AGENT_SECRET_FILE: path.join(auditDir, "secret"),
    },
    encoding: "utf8",
  });
  const sourceMatches = await forbiddenMatches([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "app",
    "lib",
    "scripts",
    "tests",
  ]);
  const artifactMatches = await forbiddenMatches([
    ".next/standalone",
    "src-tauri/resources/next-server",
    "src-tauri/resources/node",
  ]);
  const assertions = {
    bundleBuilt: build.status === 0,
    noForbiddenBundleInput: !inputs.some((input) =>
      forbidden.some((token) => input.includes(token)),
    ),
    noForbiddenBundleArtifact: !forbidden.some((token) => artifact.includes(token)),
    noForbiddenProductionSource: sourceMatches.length === 0,
    noForbiddenPackagedArtifact: artifactMatches.length === 0,
    isolatedExecution: run.status === 0 && run.stdout.includes("AR13_PI_ONLY_OK"),
    piServiceIncluded: inputs.some((input) => input.endsWith("lib/agent/pi/agent-service.ts")),
  };
  const passed = Object.values(assertions).every(Boolean);
  console.log(JSON.stringify({
    passed,
    assertions,
    sourceMatches,
    artifactMatches,
    inputFileCount: inputs.length,
    artifactBytes: Buffer.byteLength(artifact),
  }, null, 2));
  if (!passed) {
    console.error((run.stderr || run.stdout || "").slice(-2_000));
    process.exitCode = 1;
  }
} finally {
  await rm(auditDir, { recursive: true, force: true });
}
