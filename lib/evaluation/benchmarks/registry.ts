import type { BenchmarkAdapter, BenchmarkSourceFormat } from "./contracts";
import { BUILT_IN_BENCHMARK_ADAPTERS } from "./adapters";

export class BenchmarkAdapterRegistry {
  private readonly adapters = new Map<BenchmarkSourceFormat, BenchmarkAdapter>();

  constructor(adapters: readonly BenchmarkAdapter[] = BUILT_IN_BENCHMARK_ADAPTERS) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: BenchmarkAdapter): void {
    if (this.adapters.has(adapter.format)) {
      throw new Error(`benchmark adapter already registered: ${adapter.format}`);
    }
    this.adapters.set(adapter.format, adapter);
  }

  get(format: BenchmarkSourceFormat): BenchmarkAdapter {
    const adapter = this.adapters.get(format);
    if (!adapter) throw new Error(`benchmark adapter not registered: ${format}`);
    return adapter;
  }

  list(): readonly BenchmarkAdapter[] {
    return [...this.adapters.values()];
  }
}

export function createBuiltInBenchmarkAdapterRegistry(): BenchmarkAdapterRegistry {
  return new BenchmarkAdapterRegistry();
}
