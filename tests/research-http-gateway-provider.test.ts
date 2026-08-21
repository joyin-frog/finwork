import assert from "node:assert/strict";
import {
  DUE_DILIGENCE_TOPICS,
  defaultDueDiligenceCoverageRequirements,
  HttpResearchGatewayProvider,
  type ResearchCandidate,
  type ResearchQueryPlan,
} from "../lib/research/index.ts";

const NOW = "2026-08-12T00:00:00.000Z";
const candidate: ResearchCandidate = {
  id: "registry-1",
  url: "https://samr.gov.cn/company/9136",
  title: "企业登记信息",
  snippet: "官方登记来源",
  sourceClass: "regulator",
  publishedAt: "2026-08-01T00:00:00.000Z",
  region: "CN",
  entityNames: ["示例科技有限公司"],
  entityIdentifiers: { registration: "91360000123456789X" },
};

const plan: ResearchQueryPlan = {
  id: "plan-http-provider",
  caseId: "case-http-provider",
  providerId: "production-research-gateway",
  subject: {
    legalName: "示例科技有限公司",
    aliases: ["示例科技"],
    jurisdiction: "CN",
    identifiers: { registration: "91360000123456789X" },
  },
  topics: [...DUE_DILIGENCE_TOPICS],
  queries: ["示例科技有限公司 工商 诉讼 处罚 财务"],
  languages: ["zh-CN"],
  asOf: NOW,
  maxSources: 8,
  coverageRequirements: defaultDueDiligenceCoverageRequirements(DUE_DILIGENCE_TOPICS),
  policy: {
    allowedDomains: ["samr.gov.cn"],
    deniedDomains: [],
    allowedRegions: ["CN"],
    requireRobotsCompliance: true,
    allowRestrictedLicense: false,
    allowSensitivePersonalData: true,
    maxRequestsPerMinute: 30,
    maxTotalRequests: 9,
  },
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

export const researchHttpGatewayProviderTestPromise = (async () => {
  assert.throws(() => new HttpResearchGatewayProvider({
    id: "gateway",
    endpoint: "http://research.example.test/",
    token: "secret",
    authorizeDomain: () => undefined,
  }), /must use https/);
  assert.throws(() => new HttpResearchGatewayProvider({
    id: "gateway",
    endpoint: "https://research.example.test/",
    token: " ",
    authorizeDomain: () => undefined,
  }), /token is required/);

  const authorizations: string[] = [];
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let searchAttempts = 0;
  const provider = new HttpResearchGatewayProvider({
    id: "production-research-gateway",
    endpoint: "https://research.example.test/api/",
    token: "test-token",
    authorizeDomain: ({ domain, route }) => { authorizations.push(`${route}:${domain}`); },
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined },
    fetchImpl: (async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/health")) return jsonResponse({ status: "online", version: "2026.8" });
      if (url.endsWith("/v1/research/search")) {
        searchAttempts += 1;
        if (searchAttempts === 1) return jsonResponse({ error: "busy" }, { status: 503, headers: { "retry-after": "0" } });
        return jsonResponse({ candidates: [candidate] });
      }
      if (url.endsWith("/v1/research/fetch")) {
        const body = "主体：示例科技有限公司。";
        return jsonResponse({
          source: {
            candidateId: candidate.id,
            requestedUrl: candidate.url,
            finalUrl: candidate.url,
            fetchedAt: NOW,
            status: 200,
            headers: { etag: "official-v1" },
            locale: "zh-CN",
            contentType: "text/plain; charset=utf-8",
            body,
            license: "public-record",
            robotsAllowed: true,
            claims: [{
              id: "entity-claim",
              topic: "entity",
              statement: body,
              normalizedValue: { legalName: "示例科技有限公司" },
              quote: body,
              start: 0,
              end: body.length,
              confidence: 1,
            }],
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(await provider.status(), "online");
  assert.deepEqual(await provider.search(plan), [candidate]);
  assert.equal(searchAttempts, 2, "503 must be retried within the configured bound");
  const source = await provider.fetch(candidate, plan);
  assert.equal(source.finalUrl, candidate.url);
  assert(requests.every((request) => request.authorization === "Bearer test-token"));
  assert(authorizations.includes("health:research.example.test"));
  assert(authorizations.includes("search:research.example.test"));
  assert(authorizations.includes("fetch:research.example.test"));
  assert(authorizations.includes("source:samr.gov.cn"));

  const blockedProvider = new HttpResearchGatewayProvider({
    id: "blocked-gateway",
    endpoint: "https://blocked.example.test/",
    token: "test-token",
    authorizeDomain: () => undefined,
    fetchImpl: (async () => jsonResponse({ error: "blocked" }, { status: 401 })) as typeof fetch,
  });
  assert.equal(await blockedProvider.status(), "blocked");

  const oversizedProvider = new HttpResearchGatewayProvider({
    id: "oversized-gateway",
    endpoint: "https://research.example.test/",
    token: "test-token",
    authorizeDomain: () => undefined,
    maxResponseBytes: 8,
    fetchImpl: (async () => jsonResponse({ candidates: [candidate] }, { headers: { "content-length": "999" } })) as typeof fetch,
  });
  await assert.rejects(oversizedProvider.search(plan), /exceeds 8 bytes/);

  console.log("research-http-gateway-provider.test.ts: auth, strict transport, bounded retry and byte limits passed");
})();

if (process.argv[1]?.includes("research-http-gateway-provider.test")) {
  researchHttpGatewayProviderTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
