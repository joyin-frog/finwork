/**
 * Electron 与旧 Tauri 壳暂时复用同一份 Next standalone 资源组装逻辑，避免迁移窗口里
 * Python、Pi skills、MXC、ripgrep 或完整 .next/server 复制规则发生漂移。
 * Electron 验证稳定后再把共享逻辑从 prepare-tauri.mjs 提取为中性命名。
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

process.env.FINWORK_SKIP_TAURI_UPDATER = "1";
await import("./prepare-tauri.mjs");
const root = path.resolve(import.meta.dirname, "..");
const stagedApp = path.join(root, ".electron-app");
const productPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await rm(stagedApp, { recursive: true, force: true });
await mkdir(stagedApp, { recursive: true });
await build({
  entryPoints: [path.join(root, "electron", "main.cjs")],
  outfile: path.join(stagedApp, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  define: {
    __FINWORK_TELEMETRY_ENDPOINT__: JSON.stringify(process.env.TELEMETRY_ENDPOINT || ""),
    __FINWORK_TELEMETRY_TOKEN__: JSON.stringify(process.env.TELEMETRY_TOKEN || ""),
  },
  sourcemap: false,
});
await copyFile(path.join(root, "electron", "preload.cjs"), path.join(stagedApp, "preload.cjs"));
await writeFile(path.join(stagedApp, "package.json"), JSON.stringify({
  name: "finwork-desktop-shell",
  version: productPackage.version,
  private: true,
  description: "Finwork local-first desktop shell",
  author: "Finwork",
  main: "main.cjs",
}, null, 2) + "\n");
await writeFile(path.join(stagedApp, "package-lock.json"), JSON.stringify({
  name: "finwork-desktop-shell",
  version: productPackage.version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "finwork-desktop-shell",
      version: productPackage.version,
    },
  },
}, null, 2) + "\n");
await copyFile(
  path.join(root, "electron", "parent-watch.cjs"),
  path.join(root, "src-tauri", "resources", "parent-watch.cjs"),
);
console.log("prepare-electron: shared desktop resources are ready.");
