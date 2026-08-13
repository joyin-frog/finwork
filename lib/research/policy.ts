import { isIP } from "node:net";
import type { ResearchFetchedSource, ResearchQueryPlan } from "./contracts";

export class ResearchPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResearchPolicyError";
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.replace(/^\.+/, "").toLowerCase();
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function validateResearchUrl(rawUrl: string, plan: ResearchQueryPlan): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ResearchPolicyError("url_invalid", `invalid research URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ResearchPolicyError("scheme_blocked", `research URL scheme is blocked: ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "0.0.0.0" || hostname === "::1") {
    throw new ResearchPolicyError("private_network_blocked", `local research URL is blocked: ${hostname}`);
  }
  if ((isIP(hostname) === 4 && isPrivateIpv4(hostname)) || (isIP(hostname) === 6 && (hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80")))) {
    throw new ResearchPolicyError("private_network_blocked", `private research URL is blocked: ${hostname}`);
  }
  if (plan.policy.deniedDomains.some((domain) => domainMatches(hostname, domain))) {
    throw new ResearchPolicyError("domain_denied", `research domain is denied: ${hostname}`);
  }
  if (plan.policy.allowedDomains.length > 0 && !plan.policy.allowedDomains.some((domain) => domainMatches(hostname, domain))) {
    throw new ResearchPolicyError("domain_not_allowed", `research domain is outside allowlist: ${hostname}`);
  }
  return url;
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior) instructions?/i,
  /system prompt/i,
  /(?:call|invoke|run|execute) (?:the )?(?:tool|command|shell)/i,
  /(?:read|upload|exfiltrate|send) (?:a |the )?(?:local|private|secret) (?:file|data|key)/i,
  /忽略(?:之前|以上|先前).{0,12}(?:指令|要求)/,
  /(?:调用|执行).{0,8}(?:工具|命令|终端)/,
  /(?:读取|上传|发送).{0,8}(?:本地|隐私|密钥|秘密).{0,8}(?:文件|数据)/,
];

export function detectWebPromptInjection(content: string): string[] {
  return PROMPT_INJECTION_PATTERNS.filter((pattern) => pattern.test(content)).map((pattern) => pattern.source);
}

export function detectSensitivePersonalData(content: string): boolean {
  return /\b\d{17}[0-9Xx]\b/.test(content) || /(?<!\d)1[3-9]\d{9}(?!\d)/.test(content);
}

export function enforceFetchedSourcePolicy(source: ResearchFetchedSource, plan: ResearchQueryPlan): string[] {
  validateResearchUrl(source.requestedUrl, plan);
  validateResearchUrl(source.finalUrl, plan);
  const asOf = Date.parse(plan.asOf);
  if (source.publishedAt && Date.parse(source.publishedAt) > asOf) {
    throw new ResearchPolicyError("future_dated_source", `research source was published after the as-of time: ${source.finalUrl}`);
  }
  if (source.effectiveFrom && Date.parse(source.effectiveFrom) > asOf) {
    throw new ResearchPolicyError("source_not_yet_effective", `research source was not effective at the as-of time: ${source.finalUrl}`);
  }
  if (source.effectiveTo && Date.parse(source.effectiveTo) < asOf) {
    throw new ResearchPolicyError("source_no_longer_effective", `research source was no longer effective at the as-of time: ${source.finalUrl}`);
  }
  if (plan.policy.requireRobotsCompliance && !source.robotsAllowed) {
    throw new ResearchPolicyError("robots_denied", `robots policy denied snapshot: ${source.finalUrl}`);
  }
  const taints: string[] = ["web_untrusted"];
  if (detectWebPromptInjection(source.body).length > 0) taints.push("prompt_injection");
  if (detectSensitivePersonalData(source.body)) {
    if (!plan.policy.allowSensitivePersonalData) {
      throw new ResearchPolicyError("sensitive_personal_data", `sensitive personal data is outside research policy: ${source.finalUrl}`);
    }
    taints.push("sensitive_personal_data");
  }
  if (source.license?.toLowerCase().includes("restricted")) {
    if (!plan.policy.allowRestrictedLicense) throw new ResearchPolicyError("license_restricted", `restricted source license: ${source.finalUrl}`);
    taints.push("license_restricted");
  }
  return taints;
}

/** Web content is evidence only. It is never translated into runtime actions or tool authority. */
export function webContentAsUntrustedEvidence(content: string): { content: string; executableActions: never[] } {
  return { content, executableActions: [] };
}
