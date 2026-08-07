import { rm } from "node:fs/promises";
import path from "node:path";

const standaloneDir = path.join(process.cwd(), ".next", "standalone");
const generatedTauriRoots = [
  path.join(process.cwd(), "src-tauri", "resources", "next-server"),
  path.join(process.cwd(), "src-tauri", "resources", "node"),
];
await Promise.all([
  rm(standaloneDir, { recursive: true, force: true }),
  ...generatedTauriRoots.map((target) => rm(target, { recursive: true, force: true })),
]);
