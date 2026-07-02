import assert from "node:assert/strict";
import { deriveTrustTier, type TrustTier, type TrustSource, type TrustStatus } from "../lib/domain/trust-tier.ts";
import { ROLE_UI } from "../lib/domain/role-ui.ts";

const eq = assert.equal;
const ok = assert.ok;

export const trustTierTestPromise = (async () => {
  // ── AC-MATRIX: 12格推导矩阵全覆盖 (spec §2.1) ──

  // engine_calc × confirmed → verified
  eq(deriveTrustTier("engine_calc", "confirmed"), "verified", "AC-MATRIX engine_calc+confirmed=verified");
  // engine_calc × draft → pending
  eq(deriveTrustTier("engine_calc", "draft"), "pending", "AC-MATRIX engine_calc+draft=pending");
  // engine_calc × none → pending
  eq(deriveTrustTier("engine_calc", "none"), "pending", "AC-MATRIX engine_calc+none=pending");

  // file_parse × confirmed → verified
  eq(deriveTrustTier("file_parse", "confirmed"), "verified", "AC-MATRIX file_parse+confirmed=verified");
  // file_parse × draft → pending
  eq(deriveTrustTier("file_parse", "draft"), "pending", "AC-MATRIX file_parse+draft=pending");
  // file_parse × none → pending
  eq(deriveTrustTier("file_parse", "none"), "pending", "AC-MATRIX file_parse+none=pending");

  // user_dictated × confirmed → verified (特殊规则★)
  eq(deriveTrustTier("user_dictated", "confirmed"), "verified", "AC-MATRIX user_dictated+confirmed=verified(★特殊规则)");
  // user_dictated × draft → unverified
  eq(deriveTrustTier("user_dictated", "draft"), "unverified", "AC-MATRIX user_dictated+draft=unverified");
  // user_dictated × none → unverified
  eq(deriveTrustTier("user_dictated", "none"), "unverified", "AC-MATRIX user_dictated+none=unverified");

  // llm_inferred × confirmed → inferred (特殊规则★★ 永远封顶 inferred)
  eq(deriveTrustTier("llm_inferred", "confirmed"), "inferred", "AC-MATRIX llm_inferred+confirmed=inferred(★★封顶)");
  // llm_inferred × draft → inferred
  eq(deriveTrustTier("llm_inferred", "draft"), "inferred", "AC-MATRIX llm_inferred+draft=inferred(★★封顶)");
  // llm_inferred × none → inferred
  eq(deriveTrustTier("llm_inferred", "none"), "inferred", "AC-MATRIX llm_inferred+none=inferred(★★封顶)");

  // ── AC-ROLE_UI: ROLE_UI 完整性——恰好 6 个 key ──
  const keys = Object.keys(ROLE_UI);
  eq(keys.length, 6, "AC-ROLE_UI ROLE_UI 必须恰好有 6 个 key");

  const EXPECTED_KEYS = [
    "bookkeeper",
    "payroll-officer",
    "tax-officer",
    "treasury-officer",
    "receivables-officer",
    "analyst",
  ] as const;

  for (const k of EXPECTED_KEYS) {
    ok(k in ROLE_UI, `AC-ROLE_UI key "${k}" 必须存在`);
  }

  // ── AC-ROLE_UI-TONE: tone 映射逐一断言 (spec §2.3 表) ──
  eq(ROLE_UI["bookkeeper"].tone, "--tone-invoice", "AC-ROLE_UI bookkeeper.tone=--tone-invoice");
  eq(ROLE_UI["payroll-officer"].tone, "--tone-payroll", "AC-ROLE_UI payroll-officer.tone=--tone-payroll");
  eq(ROLE_UI["tax-officer"].tone, "--tone-tax", "AC-ROLE_UI tax-officer.tone=--tone-tax");
  eq(ROLE_UI["treasury-officer"].tone, "--tone-treasury", "AC-ROLE_UI treasury-officer.tone=--tone-treasury");
  eq(ROLE_UI["receivables-officer"].tone, "--tone-receivables", "AC-ROLE_UI receivables-officer.tone=--tone-receivables");
  eq(ROLE_UI["analyst"].tone, "--tone-analysis", "AC-ROLE_UI analyst.tone=--tone-analysis");

  // ── AC-ROLE_UI-ICON: 每个 key 都有 iconName 字段 ──
  for (const k of EXPECTED_KEYS) {
    ok(typeof ROLE_UI[k].iconName === "string" && ROLE_UI[k].iconName.length > 0, `AC-ROLE_UI key "${k}" 必须有非空 iconName`);
  }

  console.log("trust-tier: all matrix + ROLE_UI checks passed ✓");
})();
