import { z } from "zod/v4";
import { submitMemoryCandidate } from "@/lib/memory-v2";
import { getRoleDefinition, ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

/** 角色口径候选提取：只进入治理队列，不直接写入角色提示词。 */
export function createRememberRoleConventionTool(sdk: Sdk) {
  const roleIds = ROLE_REGISTRY.map((r) => `${r.id}(${r.name})`).join("、");
  return sdk.tool(
    "remember_role_convention",
    [
      "把用户确认的专员职责域口径提交为该角色的受治理候选；候选不会直接进入后续派发提示词。",
      "只记跨任务规则、例外或流程偏好；一次性决定、数值结果和任务状态不要记。跨角色约定改用 remember_convention。",
      `roleId 可选值:${roleIds}。`,
    ].join("\n"),
    {
      roleId: z.string().describe("口径归属的角色 id"),
      text: z.string().min(2).max(300).describe("口径原文,一句话,财务语言,忠实转述不扩写"),
      source: z.string().min(2).max(80).describe("来源标注:产生这条口径的任务或话题,如「6月算薪复核」"),
      conversationId: z.number().nullish().describe("当前会话 ID,用于绑定用户确认来源"),
    },
    async (args: { roleId: string; text: string; source: string; conversationId?: number | null }) => {
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
        const result = submitMemoryCandidate({
          text,
          roleId: role.id,
          source: source || "remember_role_convention",
          conversationId: args.conversationId ?? undefined,
        });
        return {
          content: [{
            type: "text" as const,
            text: result.duplicate
              ? `「${role.name}」已有相同口径候选，未重复提交；审核通过前不会进入后续提示词。`
              : `已为「${role.name}」提交口径候选「${text}」；审核和验证通过前不会进入后续提示词。`,
          }],
          structuredContent: {
            roleId: role.id,
            text,
            source,
            candidateId: result.candidate?.id,
            candidateStatus: result.candidate?.approvalStatus,
            duplicate: result.duplicate,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `口径候选提交失败:${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const,
        };
      }
    }
  );
}
