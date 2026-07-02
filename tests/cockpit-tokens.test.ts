import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const eq = assert.equal;
const ok = assert.ok;

const ROOT = process.cwd();
const globalsCss = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");

// ── AC-CSS-TOKEN: globals.css 5 个新 tone token 双段存在性 (spec §2.3) ──
// 每个 token 必须在浅色段(:root)和深色段(.dark)各出现一次，共两次
const NEW_TOKENS = [
  "--tone-unverified",
  "--tone-tax",
  "--tone-treasury",
  "--tone-receivables",
  "--tone-analysis",
] as const;

export const cockpitTokensTestPromise = (async () => {
  for (const token of NEW_TOKENS) {
    // 统计该 token 在文件中出现的总次数（涵盖定义行）
    const re = new RegExp(token.replace(/-/g, "\\-"), "g");
    const matches = globalsCss.match(re) ?? [];
    assert.ok(
      matches.length >= 2,
      `AC-CSS-TOKEN "${token}" 必须在 globals.css 出现至少 2 次(浅色段+深色段各一次),实际出现 ${matches.length} 次`
    );
  }

  // ── AC-CSS-TOKEN-LIGHT: 浅色段(:root)包含各 token 定义 ──
  // 浅色段在 .dark { 之前（取 .dark 出现之前的文本部分）
  const darkIdx = globalsCss.indexOf(".dark {");
  ok(darkIdx > 0, "AC-CSS-TOKEN-LIGHT globals.css 必须包含 .dark { 段");
  const lightSection = globalsCss.slice(0, darkIdx);

  for (const token of NEW_TOKENS) {
    ok(
      lightSection.includes(token),
      `AC-CSS-TOKEN-LIGHT "${token}" 必须在浅色段(:root / .dark 之前)出现`
    );
  }

  // ── AC-CSS-TOKEN-DARK: 深色段(.dark)包含各 token 定义 ──
  const darkSection = globalsCss.slice(darkIdx);

  for (const token of NEW_TOKENS) {
    ok(
      darkSection.includes(token),
      `AC-CSS-TOKEN-DARK "${token}" 必须在深色段(.dark { ... })中出现`
    );
  }

  // ── AC-TRUST-BADGE-EXISTS: trust-badge.tsx 文件存在 ──
  const badgePath = path.join(ROOT, "app/shared/trust-badge.tsx");
  ok(existsSync(badgePath), `AC-TRUST-BADGE-EXISTS app/shared/trust-badge.tsx 必须存在`);

  const badgeSrc = readFileSync(badgePath, "utf8");

  // ── AC-TRUST-BADGE-CLASS: 含 fa-tone-pill 类名 (spec §2.2) ──
  ok(
    badgeSrc.includes("fa-tone-pill"),
    "AC-TRUST-BADGE-CLASS trust-badge.tsx 源码必须包含 fa-tone-pill"
  );

  // ── AC-TRUST-BADGE-LABELS: 四个中文文案全部存在 (spec §2.2 表) ──
  const EXPECTED_LABELS = ["已核实", "待确认", "推测", "未核实"] as const;
  for (const label of EXPECTED_LABELS) {
    ok(
      badgeSrc.includes(label),
      `AC-TRUST-BADGE-LABELS trust-badge.tsx 源码必须包含文案「${label}」`
    );
  }

  // ── AC-TRUST-BADGE-VARS: 四个 tone 变量引用全部存在 (spec §2.2 表) ──
  const EXPECTED_VARS = ["--tone-ok", "--tone-warn", "--tone-neutral", "--tone-unverified"] as const;
  for (const v of EXPECTED_VARS) {
    ok(
      badgeSrc.includes(v),
      `AC-TRUST-BADGE-VARS trust-badge.tsx 源码必须引用 CSS 变量 "${v}"`
    );
  }

  console.log("cockpit-tokens: all CSS token + trust-badge source checks passed ✓");
})();
