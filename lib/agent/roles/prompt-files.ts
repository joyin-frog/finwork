import { readFileSync } from "node:fs";
import path from "node:path";
import { getProjectRoot } from "@/lib/runtime/paths";
import type { RoleDefinition } from "./registry";

/** Role-specific prompt files are the editable SSOT; registry text remains a safe fallback. */
export function getRolePromptPath(roleId: string): string {
  return path.join(getProjectRoot(), "lib", "agent", "roles", "prompts", `${roleId}.md`);
}

export function loadRolePromptFile(role: RoleDefinition): string {
  const promptPath = getRolePromptPath(role.id);
  try {
    const text = readFileSync(promptPath, "utf8").trim();
    if (text) return `${text}\n\n${role.rolePrompt}`;
  } catch {
    // Packaged/legacy environments may not have the editable file yet.
  }
  return role.rolePrompt;
}
