import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const uv = process.env.FINWORK_UV_BIN || "uv";
const targets = new Map([
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["win32-x64", "x86_64-pc-windows-msvc"],
]);
const requested = process.argv.slice(2);
const selected = requested.length > 0 ? requested : [...targets.keys()];
const resolutionCutoff = "2026-08-23";
const wheelHashCache = new Map();

async function officialWheelHashes(name, version) {
  const key = `${name}==${version}`;
  if (wheelHashCache.has(key)) return wheelHashCache.get(key);

  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const metadata = await response.json();
      const hashes = [...new Set(metadata.urls
        .filter((file) => file.packagetype === "bdist_wheel" && !file.yanked)
        .map((file) => file.digests?.sha256)
        .filter(Boolean))].sort();
      if (hashes.length === 0) throw new Error("no non-yanked wheel files");
      wheelHashCache.set(key, hashes);
      return hashes;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw new Error(`PyPI wheel metadata failed for ${key}`, { cause: lastError });
}

async function hydrateOfficialWheelHashes(lockText) {
  const records = lockText.trim().split(/\n(?=\S)/);
  const hydrated = [];
  for (const record of records) {
    const firstLine = record.slice(0, record.indexOf("\n") === -1 ? undefined : record.indexOf("\n"));
    const match = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==([^ ;\\]+)(?: ; .*)? \\/.exec(firstLine);
    if (!match) throw new Error(`Cannot parse uv lock record: ${firstLine}`);
    const [, name, version] = match;
    const hashes = await officialWheelHashes(name, version);
    const spec = firstLine.slice(0, -2);
    hydrated.push(`${spec} \\\n${hashes.map((hash, index) => `    --hash=sha256:${hash}${index === hashes.length - 1 ? "" : " \\"}`).join("\n")}`);
  }
  return hydrated.join("\n") + "\n";
}

for (const id of selected) {
  const pythonPlatform = targets.get(id);
  if (!pythonPlatform) throw new Error(`Unknown runtime-lock target: ${id}`);
  const output = path.join("runtime-lock", `${id}.txt`);
  const temporaryOutput = `${output}.uv.tmp`;
  const result = spawnSync(uv, [
    "--quiet",
    "pip",
    "compile",
    "requirements.txt",
    "--python-version", "3.12.5",
    "--python-platform", pythonPlatform,
    "--generate-hashes",
    "--no-annotate",
    "--no-header",
    "--no-strip-extras",
    "--only-binary", ":all:",
    "--exclude-newer", resolutionCutoff,
    "--no-python-downloads",
    "--output-file", temporaryOutput,
  ], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`uv lock generation failed for ${id} (exit ${result.status})`);
  const uvLock = await readFile(path.join(root, temporaryOutput), "utf8");
  const lock = await hydrateOfficialWheelHashes(uvLock);
  await writeFile(path.join(root, output), lock, "utf8");
  await unlink(path.join(root, temporaryOutput));
  console.log(`generate-python-runtime-locks: wrote ${output}`);
}
