import { z } from "zod/v4";
import { addRoleMemory, listRoleMemory } from "@/lib/db/role-memory-store";
import { getRoleDefinition, ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

/** 角色口径自动沉淀（智能体 IA · 刀 6）：静默写入该角色独立记忆,不弹确认卡。 */
export function createRememberRoleConventionTool(sdk: Sdk) {
  const roleIds = ROLE_REGISTRY.map((r) => `${r.id}(${r.name})`).join("、");
  return sdk.tool(
    "remember_role_convention",
    [
      "把用户确认的专员职责域口径写入该角色独立记忆，供后续派发复用。",
      "只记跨任务规则、例外或流程偏好；一次性决定、数值结果和任务状态不要记。跨角色约定改用 remember_convention。",
      `roleId 可选值:${roleIds}。`,
    ].join("\n"),
    {
      roleId: z.string().describe("口径归属的角色 id"),
      text: z.string().min(2).max(300).describe("口径原文,一句话,财务语言,忠实转述不扩写"),
      source: z.string().min(2).max(80).describe("来源标注:产生这条口径的任务或话题,如「6月算薪复核」"),
    },
    async (args: { roleId: string; text: string; source: string }) => {
      try {
        const role = getRoleDefinition(args.roleId);
        if (!role) {
          return {
            content: [{ type: "text" as const, text: `未知角色「${args.roleId}」,可选:${roleIds}。` }],
            isError: true as const,
          };
        }
        const clean = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/^#+\s*/, "").trim();
        const text = clean(args.text);
        const source = clean(args.source);
        if (!text) {
          return {
            content: [{ type: "text" as const, text: "口径内容为空,没有可记的。" }],
            isError: true as const,
          };
        }
        // 跨会话去重:主对话看不到既有角色记忆,同一口径可能被反复沉淀,完全相同的内容跳过。
        if (listRoleMemory(role.id).some((m) => m.content === text)) {
          return {
            content: [{ type: "text" as const, text: `「${role.name}」的记忆里已有这条口径,未重复写入。` }],
            structuredContent: { roleId: role.id, duplicate: true },
          };
        }
        addRoleMemory(role.id, text, source || null);
        return {
          content: [{
            type: "text" as const,
            text: `已记住这条口径(仅「${role.name}」可见):「${text}」。之后派发该角色会自动遵守;可在 智能体 → ${role.name} → 记忆 查看或删除。`,
          }],
          structuredContent: { roleId: role.id, text, source },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `口径保存失败:${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const,
        };
      }
    }
  );
}
