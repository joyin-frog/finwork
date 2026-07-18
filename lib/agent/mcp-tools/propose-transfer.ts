import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import { getRoleDefinition, ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import { getDisabledRoleIds } from "@/lib/agent/roles/availability";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

/**
 * propose_transfer — 越权转交卡（D2·刀8）。
 *
 * 工具本身不执行任何操作：仅校验目标角色可用性，返回 structuredContent 供前端渲染转交卡。
 * riskLevel = safe，进 ALLOWED_TOOLS 静默放行。
 *
 * 前端读 structuredContent.kind === "transfer_proposal" 渲染转交卡；
 * 用户点「转给X处理」后 POST /api/agents/transfer 创建排队任务。
 */
export function createProposeTransferTool(sdk: Sdk, conversationId?: string) {
  const validRoleIds = ROLE_REGISTRY.map((r) => `${r.id}(${r.name})`).join("、");
  return sdk.tool(
    "propose_transfer",
    [
      "当用户请求超出当前角色职责或数据权限时，发一张转交卡——说明原因、建议转给哪位专员处理。",
      "工具不执行任何动作，只在对话流里展示一张转交卡；用户点击卡片上的按钮才会真正发起转交。",
      "instructions 要写完整的任务指令（目标专员看到后能直接开工，上下文已自动带全，用户不用重新描述）。",
      `targetRoleId 可选值：${validRoleIds}。`,
    ].join("\n"),
    {
      targetRoleId: z.string().describe("应转交的目标角色 id"),
      taskSummary: z.string().min(2).max(80).describe("一句话任务名，显示在转交卡标题"),
      instructions: z.string().min(5).max(2000).describe("给目标角色的完整任务指令，包含所有必要上下文"),
      reason: z.string().min(2).max(200).describe("为什么转交——一句话说明超出了哪项职责或数据边界"),
    },
    async (args: { targetRoleId: string; taskSummary: string; instructions: string; reason: string }) => {
      // 校验目标角色存在
      const targetRole = getRoleDefinition(args.targetRoleId);
      if (!targetRole) {
        return {
          content: [{ type: "text" as const, text: `未知角色「${args.targetRoleId}」，可选：${validRoleIds}。` }],
          isError: true as const,
        };
      }
      // 校验角色注册表可用（available:false = 预留未启用）
      if (!targetRole.available) {
        return {
          content: [{ type: "text" as const, text: `角色「${targetRole.name}」尚未启用，无法转交。` }],
          isError: true as const,
        };
      }
      // 校验用户未停用（fail-closed：配置读取失败时拒绝转交，要求稍后重试）
      let disabledIds: string[];
      try {
        disabledIds = getDisabledRoleIds();
      } catch {
        return {
          content: [{ type: "text" as const, text: "无法读取角色停用配置，请稍后重试。" }],
          isError: true as const,
        };
      }
      if (disabledIds.includes(args.targetRoleId)) {
        return {
          content: [{ type: "text" as const, text: `角色「${targetRole.name}」已停用，无法转交。请先在「智能体」页面启用该专员。` }],
          isError: true as const,
        };
      }

      // 解析 conversationId（字符串转整数，null 时不嵌入）
      const convId = conversationId != null ? Number(conversationId) : null;
      const dbConvId = convId != null && !isNaN(convId) ? convId : null;

      return {
        content: [{
          type: "text" as const,
          text: `建议转交给「${targetRole.name}」：${args.reason}`,
        }],
        structuredContent: {
          kind: "transfer_proposal" as const,
          // M3·刀8: proposalId 作为 localStorage 键的稳定唯一标识，
          // 避免同角色同摘要前缀的第二张转交卡撞键显示"已处理"。
          proposalId: randomUUID(),
          targetRoleId: args.targetRoleId,
          targetRoleName: targetRole.name,
          taskSummary: args.taskSummary,
          instructions: args.instructions,
          reason: args.reason,
          originConversationId: dbConvId,
        },
      };
    }
  );
}
