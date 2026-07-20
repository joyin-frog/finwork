/**
 * 角色 Hugeicons 映射（client-safe）。
 * 唯一按 ROLE_UI.iconName 解析，避免导航与 ROLE_UI 各维护一份图标表。
 */
import type { IconSvgElement } from "@hugeicons/react";
import {
  ChartLineData01Icon,
  DollarSquareIcon,
  Invoice01Icon,
  NoteEditIcon,
  NoteIcon,
  TaxesIcon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { ROLE_UI, type RoleId } from "@/lib/domain/role-ui";

const ICONS_BY_NAME = {
  "note-edit": NoteEditIcon,
  "user-account": UserAccountIcon,
  tax: TaxesIcon,
  "dollar-square": DollarSquareIcon,
  invoice: Invoice01Icon,
  "chart-line-data-01": ChartLineData01Icon,
} as const satisfies Record<string, IconSvgElement>;

/** 按 roleId 取岗位语义图标；未知角色回落 NoteIcon。 */
export function roleNavIcon(roleId: string): IconSvgElement {
  const name = ROLE_UI[roleId as RoleId]?.iconName;
  if (name && name in ICONS_BY_NAME) {
    return ICONS_BY_NAME[name as keyof typeof ICONS_BY_NAME];
  }
  return NoteIcon;
}
