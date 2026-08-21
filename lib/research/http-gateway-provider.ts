import { z } from "zod";
import { withTransientProviderRetry, type ProviderRetryOptions } from "@/lib/evaluation/transient-provider-retry";
import {
  ResearchCandidateSchema,
  ResearchFetchedSourceSchema,
  ResearchQueryPlanSchema,
  type ResearchCandidate,
  type ResearchFetchedSource,
  type ResearchQueryPlan,
} from "./contracts";
import type { ResearchProvider, ResearchProviderStatus } from "./provider";

const GatewayHealthSchema = z.object({
  status: z.enum(["online", "offline", "blocked"]),
  version: z.string().trim().min(1),
}).strict();

const GatewaySearchResponseSchema = z.object({
  candidates: z.array(ResearchCandidateSchema),
}).strict();

const GatewayFetchResponseSchema = z.object({
  source: ResearchFetchedSourceSchema,
}).strict();

type GatewayRoute = "health" | "search" | "fetch";

export type ResearchGatewayAuthorizationContext = {
  domain: string;
  route: GatewayRoute | "source";
  plan?: ResearchQueryPlan;
};

export type HttpResearchGatewayProviderOptions = {
  id: string;
  endpoint: string;
  token: string;
  authorizeDomain: (context: ResearchGatewayAuthorizationContext) => void | Promise<void>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  retry?: ProviderRetryOptions;
  fetchImpl?: typeof fetch;
  allowInsecureHttpForTests?: boolean;
};

class ResearchGatewayHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ResearchGatewayHttpError";
  }
}

function parsePositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function normalizedDomain(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

export class HttpResearchGatewayProvider implements ResearchProvider {
  readonly id: string;
  readonly endpoint: URL;
  readonly gatewayDomain: string;
  private readonly token: string;
  private readonly authorizeDomain: HttpResearchGatewayProviderOptions["authorizeDomain"];
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly retry: ProviderRetryOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpResearchGatewayProviderOptions) {
    this.id = options.id.trim();
    if (!this.id) throw new Error("research gateway provider id is required");
    this.endpoint = new URL(options.endpoint);
    if (this.endpoint.protocol !== "https:" && !(options.allowInsecureHttpForTests && this.endpoint.protocol === "http:")) {
      throw new Error("research gateway endpoint must use https");
    }
    this.gatewayDomain = this.endpoint.hostname.toLowerCase();
    this.token = options.token.trim();
    if (!this.token) throw new Error("research gateway token is required");
    this.authorizeDomain = options.authorizeDomain;
    this.timeoutMs = parsePositiveInteger(options.timeoutMs, 20_000, 120_000);
    this.maxResponseBytes = parsePositiveInteger(options.maxResponseBytes, 12_000_000, 20_000_000);
    this.retry = options.retry ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async status(): Promise<ResearchProviderStatus> {
    try {
      const health = await this.request("health", undefined, undefined, false);
      return GatewayHealthSchema.parse(health).status;
    } catch (error) {
      if (error instanceof ResearchGatewayHttpError && [401, 403].includes(error.status)) return "blocked";
      if (error instanceof Error && /authoriz|egress|policy|deny/i.test(error.message)) return "blocked";
      return "offline";
    }
  }

  async search(rawPlan: ResearchQueryPlan): Promise<ResearchCandidate[]> {
    const plan = ResearchQueryPlanSchema.parse(rawPlan);
    const result = await withTransientProviderRetry(
      () => this.request("search", { plan }, plan, true),
      this.retry,
    );
    return GatewaySearchResponseSchema.parse(result.value).candidates;
  }

  async fetch(rawCandidate: ResearchCandidate, rawPlan: ResearchQueryPlan): Promise<ResearchFetchedSource> {
    const candidate = ResearchCandidateSchema.parse(rawCandidate);
    const plan = ResearchQueryPlanSchema.parse(rawPlan);
    await this.authorizeDomain({ domain: normalizedDomain(candidate.url), route: "source", plan });
    const result = await withTransientProviderRetry(
      () => this.request("fetch", { candidate, plan }, plan, true),
      this.retry,
    );
    const source = GatewayFetchResponseSchema.parse(result.value).source;
    await this.authorizeDomain({ domain: normalizedDomain(source.finalUrl), route: "source", plan });
    return source;
  }

  private async request(
    route: GatewayRoute,
    body: unknown,
    plan: ResearchQueryPlan | undefined,
    isPost: boolean,
  ): Promise<unknown> {
    await this.authorizeDomain({ domain: this.gatewayDomain, route, ...(plan ? { plan } : {}) });
    const target = new URL(route === "health" ? "health" : `v1/research/${route}`, this.endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("research gateway request timed out")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(target, {
        method: isPost ? "POST" : "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(isPost ? { "content-type": "application/json" } : {}),
        },
        ...(isPost ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ResearchGatewayHttpError(
          `research gateway request failed with HTTP ${response.status}`,
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
        throw new Error(`research gateway response exceeds ${this.maxResponseBytes} bytes`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxResponseBytes) {
        throw new Error(`research gateway response exceeds ${this.maxResponseBytes} bytes`);
      }
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw new Error("research gateway returned invalid JSON", { cause: error });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
