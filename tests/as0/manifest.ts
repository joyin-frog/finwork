import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GoldenManifest, GoldenTask } from "./types";

export const AS0_MANIFEST_PATH = "docs/spec/fixtures/as0-golden-tasks.v1.json";

export function loadManifest(repoRoot = process.cwd()): {
  manifest: GoldenManifest;
  manifestPath: string;
  fixtureRoot: string;
} {
  const manifestPath = path.join(repoRoot, AS0_MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as GoldenManifest;
  const fixtureRoot = path.resolve(path.dirname(manifestPath), manifest.fixtureRoot);
  return { manifest, manifestPath, fixtureRoot };
}

export function selectTasks(manifest: GoldenManifest, ids: string[]): GoldenTask[] {
  if (ids.length === 0) return manifest.tasks;
  const requested = new Set(ids);
  const selected = manifest.tasks.filter((task) => requested.has(task.id));
  const missing = ids.filter((id) => !selected.some((task) => task.id === id));
  if (missing.length > 0) throw new Error(`未知 AS0 task: ${missing.join(", ")}`);
  return selected;
}

export function fixturePath(fixtureRoot: string, relativePath: string): string {
  const resolved = path.resolve(fixtureRoot, relativePath);
  // AS0 自有 fixture 在 tests/as0/fixtures，同时允许复用 tests/golden/fixtures。
  const allowedTestsRoot = path.resolve(fixtureRoot, "../..");
  if (!resolved.startsWith(`${allowedTestsRoot}${path.sep}`)) {
    throw new Error(`fixture 越界: ${relativePath}`);
  }
  if (!existsSync(resolved)) throw new Error(`fixture 不存在: ${relativePath}`);
  return resolved;
}

export function defaultAttempts(task: GoldenTask): number {
  return task.id === "AS0-19" || task.id === "AS0-20" ? 2 : 3;
}
