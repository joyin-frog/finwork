"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { load } = require("js-yaml");

function writeUpdateFixture(directory, metadataName, artifactName, payload, releaseDate) {
  const artifact = path.join(directory, artifactName);
  fs.writeFileSync(artifact, payload);
  fs.writeFileSync(`${artifact}.blockmap`, `blockmap:${artifactName}`);
  const info = {
    version: "1.2.3",
    files: [{
      url: artifactName,
      sha512: crypto.createHash("sha512").update(payload).digest("base64"),
      size: Buffer.byteLength(payload),
    }],
    path: artifactName,
    sha512: crypto.createHash("sha512").update(payload).digest("base64"),
    releaseDate,
  };
  fs.writeFileSync(path.join(directory, metadataName), require("js-yaml").dump(info));
  return artifact;
}

test("release merger retains both macOS architectures and Windows metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-electron-release-"));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const x64 = path.join(input, "electron-macos-15-intel-x64");
  const arm64 = path.join(input, "electron-macos-15-arm64");
  const windows = path.join(input, "electron-windows-latest-x64");
  fs.mkdirSync(x64, { recursive: true });
  fs.mkdirSync(arm64, { recursive: true });
  fs.mkdirSync(windows, { recursive: true });
  const x64Artifact = writeUpdateFixture(x64, "latest-mac.yml", "Finwork-1.2.3-mac.zip", "x64", "2026-08-23T00:00:00Z");
  writeUpdateFixture(arm64, "latest-mac.yml", "Finwork-1.2.3-arm64-mac.zip", "arm64", "2026-08-23T00:00:01Z");
  writeUpdateFixture(windows, "latest.yml", "Finwork-Setup-1.2.3.exe", "windows", "2026-08-23T00:00:01Z");

  try {
    const result = spawnSync(process.execPath, ["scripts/merge-electron-release.mjs", input, output], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const merged = load(fs.readFileSync(path.join(output, "latest-mac.yml"), "utf8"));
    assert.deepEqual(merged.files.map((file) => file.url), [
      "Finwork-1.2.3-mac.zip",
      "Finwork-1.2.3-arm64-mac.zip",
    ]);
    assert.equal(merged.releaseDate, "2026-08-23T00:00:01Z");
    assert.equal(fs.existsSync(path.join(output, "latest.yml")), true);
    assert.equal(fs.existsSync(path.join(output, "Finwork-Setup-1.2.3.exe")), true);

    fs.writeFileSync(x64Artifact, "tampered");
    const rejected = spawnSync(process.execPath, ["scripts/merge-electron-release.mjs", input, path.join(root, "rejected")], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0, "tampered release artifact must be rejected");
    assert.match(rejected.stderr, /size mismatch|SHA-512 mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("electron-updater selects the matching macOS architecture from merged metadata", () => {
  const { MacUpdater } = require(path.resolve(__dirname, "../node_modules/electron-updater/out/MacUpdater.js"));
  const files = [
    { url: new URL("https://example.test/Finwork-1.2.3-mac.zip"), info: { url: "Finwork-1.2.3-mac.zip" } },
    { url: new URL("https://example.test/Finwork-1.2.3-arm64-mac.zip"), info: { url: "Finwork-1.2.3-arm64-mac.zip" } },
  ];
  assert.deepEqual(MacUpdater.filterFilesForArch(files, false).map((file) => file.info.url), ["Finwork-1.2.3-mac.zip"]);
  assert.deepEqual(MacUpdater.filterFilesForArch(files, true).map((file) => file.info.url), ["Finwork-1.2.3-arm64-mac.zip"]);
});
