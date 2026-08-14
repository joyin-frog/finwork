import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadRealBenchmarkInputs, selectRealBenchmarkCases } from "../lib/evaluation/benchmarks/real-runner.ts";
import { BenchmarkProfileSchema } from "../lib/evaluation/benchmarks/contracts.ts";
import { createModelMatrixPlan } from "../lib/evaluation/benchmarks/evaluation-layers.ts";

const goalRoot = path.join(process.cwd(), ".finwork-test", "benchmarks", "goal", "spec-real-api-benchmark-execution-v1");

function args(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  const values = argv.filter((value) => value !== "--");
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument near ${key ?? "end"}`);
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

function positiveInt(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  const input = args(process.argv.slice(2));
  const candidates = (input.get("models") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const repetitions = positiveInt(input.get("repetitions"), "--repetitions");
  const profile = BenchmarkProfileSchema.parse(input.get("profile") ?? "benchmark-smoke");
  const maxCases = positiveInt(input.get("max-cases") ?? "7", "--max-cases");
  const state = JSON.parse(await readFile(path.join(goalRoot, "state.json"), "utf8")) as { importedManifests?: unknown };
  const loaded = await loadRealBenchmarkInputs((state.importedManifests ?? []) as Parameters<typeof loadRealBenchmarkInputs>[0]);
  const profileCases = selectRealBenchmarkCases({
    profile,
    cases: loaded.cases,
    bundles: loaded.bundles,
    sampleSeed: input.get("sample-seed") ?? "model-matrix-v1",
    maxCases,
  });
  const plan = createModelMatrixPlan({ candidates, repetitions, cases: profileCases });
  console.log(JSON.stringify({
    preview: true,
    networkRequests: 0,
    ...plan,
    providerRequestsIfExecuted: plan.runs.length,
    note: "Each matrix cell requires its own preview and explicit real-API budgets through eval:benchmarks:real --layer model.",
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error instanceof Error ? error.message : "model_matrix_plan_failed" }));
  process.exitCode = 1;
});
