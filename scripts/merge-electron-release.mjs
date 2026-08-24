import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";

const inputRoot = path.resolve(process.argv[2] || "release-input");
const outputRoot = path.resolve(process.argv[3] || "dist-release");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function macArchitecture(info) {
  const urls = Array.isArray(info?.files) ? info.files.map((file) => String(file?.url || "")) : [];
  return urls.some((url) => url.includes("arm64")) ? "arm64" : "x64";
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function sha512(filePath) {
  return createHash("sha512").update(await readFile(filePath)).digest("base64");
}

function releaseAssetName(url) {
  const pathname = String(url || "").split(/[?#]/, 1)[0];
  return decodeURIComponent(path.posix.basename(pathname));
}

async function validateUpdateMetadata(label, info, allFiles) {
  if (!info || typeof info.version !== "string" || !Array.isArray(info.files) || info.files.length === 0) {
    throw new Error(`${label} update metadata is incomplete`);
  }
  const byName = new Map(allFiles.map((file) => [path.basename(file), file]));
  for (const entry of info.files) {
    const name = releaseAssetName(entry?.url);
    const asset = byName.get(name);
    if (!asset) throw new Error(`${label} update asset is missing: ${name}`);
    const actualSize = (await stat(asset)).size;
    if (Number(entry.size) !== actualSize) {
      throw new Error(`${label} update asset size mismatch: ${name} metadata=${entry.size} actual=${actualSize}`);
    }
    const actualSha512 = await sha512(asset);
    if (entry.sha512 !== actualSha512) {
      throw new Error(`${label} update asset SHA-512 mismatch: ${name}`);
    }
    if (/\.(zip|exe)$/i.test(name) && !byName.has(`${name}.blockmap`)) {
      throw new Error(`${label} differential update blockmap is missing: ${name}.blockmap`);
    }
  }
}

async function copyUnique(source) {
  const destination = path.join(outputRoot, path.basename(source));
  try {
    if (await sha256(source) !== await sha256(destination)) {
      throw new Error(`Release artifact name collision: ${path.basename(source)}`);
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await copyFile(source, destination);
}

const files = await walk(inputRoot);
const macMetadataFiles = files.filter((file) => path.basename(file) === "latest-mac.yml");
const windowsMetadataFiles = files.filter((file) => path.basename(file) === "latest.yml");
if (macMetadataFiles.length !== 2) {
  throw new Error(`Expected two latest-mac.yml files, found ${macMetadataFiles.length}`);
}
if (windowsMetadataFiles.length !== 1) {
  throw new Error(`Expected one latest.yml file, found ${windowsMetadataFiles.length}`);
}

const macMetadata = await Promise.all(macMetadataFiles.map(async (file) => ({
  file,
  info: load(await readFile(file, "utf8")),
})));
for (const entry of macMetadata) {
  await validateUpdateMetadata(path.basename(path.dirname(entry.file)), entry.info, files);
}
const windowsInfo = load(await readFile(windowsMetadataFiles[0], "utf8"));
await validateUpdateMetadata("Windows", windowsInfo, files);
const byArchitecture = new Map(macMetadata.map((entry) => [macArchitecture(entry.info), entry.info]));
const x64 = byArchitecture.get("x64");
const arm64 = byArchitecture.get("arm64");
if (!x64 || !arm64 || x64.version !== arm64.version) {
  throw new Error("macOS update metadata must contain matching x64 and arm64 versions");
}
if (windowsInfo.version !== x64.version) {
  throw new Error(`Windows/macOS update versions differ: ${windowsInfo.version} vs ${x64.version}`);
}

const combinedFiles = [...x64.files, ...arm64.files].filter((file, index, all) => (
  all.findIndex((candidate) => candidate.url === file.url) === index
));
const combined = {
  ...x64,
  files: combinedFiles,
  releaseDate: [x64.releaseDate, arm64.releaseDate].filter(Boolean).sort().at(-1),
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const file of files) {
  if (["latest-mac.yml", "latest.yml", "builder-debug.yml", "builder-effective-config.yaml"].includes(path.basename(file))) continue;
  await copyUnique(file);
}
await writeFile(path.join(outputRoot, "latest-mac.yml"), dump(combined, { lineWidth: -1, noRefs: true }));
await copyFile(windowsMetadataFiles[0], path.join(outputRoot, "latest.yml"));

console.log(`merge-electron-release: ${combinedFiles.length} macOS update files and ${files.length - 3} release assets are ready.`);
