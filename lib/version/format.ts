/**
 * 把构建期注入的原始版本号净化成展示串。
 * 缺失/脏值一律回退到「版本未知」,避免关于页露出 "vundefined" 或空 "v"。
 */
export function formatAppVersion(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().replace(/^v/i, "").trim();
  if (!trimmed) return "版本未知";
  return `v${trimmed}`;
}
