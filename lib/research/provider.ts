import type { ResearchCandidate, ResearchFetchedSource, ResearchQueryPlan } from "./contracts";

export type ResearchProviderStatus = "online" | "offline" | "blocked";

export interface ResearchProvider {
  readonly id: string;
  status(): ResearchProviderStatus | Promise<ResearchProviderStatus>;
  search(plan: ResearchQueryPlan): Promise<ResearchCandidate[]>;
  fetch(candidate: ResearchCandidate, plan: ResearchQueryPlan): Promise<ResearchFetchedSource>;
}

export class ResearchProviderError extends Error {
  constructor(
    readonly code: "provider_missing" | "provider_offline" | "provider_blocked" | "provider_failed",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ResearchProviderError";
  }
}

export class ResearchProviderRegistry {
  private readonly providers = new Map<string, ResearchProvider>();

  register(provider: ResearchProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`research provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  async requireOnline(id: string): Promise<ResearchProvider> {
    const provider = this.providers.get(id);
    if (!provider) throw new ResearchProviderError("provider_missing", `research provider is not configured: ${id}`);
    const status = await provider.status();
    if (status === "offline") throw new ResearchProviderError("provider_offline", `research provider is offline: ${id}`);
    if (status === "blocked") throw new ResearchProviderError("provider_blocked", `research provider is blocked by policy: ${id}`);
    return provider;
  }
}
