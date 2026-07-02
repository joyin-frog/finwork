/**
 * 角色 UI 映射（client-safe）— spec §2.3
 *
 * tone 值对应 globals.css 里的 CSS 变量名（字符串，运行时通过 style={{ "--tone": ... }} 注入）。
 * iconName 来自 Hugeicons 体系，选语义最贴近的名称。
 *
 * 禁止 import lib/agent 下任何东西（client-safe 约束）。
 */

export type RoleId =
  | "bookkeeper"
  | "payroll-officer"
  | "tax-officer"
  | "treasury-officer"
  | "receivables-officer"
  | "analyst";

export type RoleUiSpec = {
  tone: string;
  iconName: string;
};

export const ROLE_UI: Record<RoleId, RoleUiSpec> = {
  "bookkeeper": {
    tone: "--tone-invoice",
    iconName: "receipt",
  },
  "payroll-officer": {
    tone: "--tone-payroll",
    iconName: "user-account",
  },
  "tax-officer": {
    tone: "--tone-tax",
    iconName: "tax",
  },
  "treasury-officer": {
    tone: "--tone-treasury",
    iconName: "bank",
  },
  "receivables-officer": {
    tone: "--tone-receivables",
    iconName: "invoice",
  },
  "analyst": {
    tone: "--tone-analysis",
    iconName: "chart-line-data-01",
  },
};
