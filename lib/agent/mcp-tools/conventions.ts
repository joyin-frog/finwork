import { z } from "zod/v4";
import { submitMemoryCandidate } from "@/lib/memory-v2";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

export function createRememberConventionTool(sdk: Sdk) {
  return sdk.tool(
    "remember_convention",
    [
      "新增、修改或取消跨对话长期生效的工作约定；本次会话口径、临时决定、结果和任务状态不要调用。",
      "仅响应用户明确的“记住/以后/长期/默认”意图；不得根据历史任务、行为或模型推测创建候选。",
      "新增填 text；修改同时填旧原文 replaces 和新 text；纯取消只填 replaces。忠实转述，不扩写或追加否定条目。",
      "系统会向用户确认后提交受治理候选；候选经冲突检查、审批和验证后才会进入后续提示词。专员职责域口径改用 remember_role_convention。",
    ].join("\n"),
    {
      text: z.string().min(2).max(300).nullish().describe("约定原文,一句话,财务语言;纯取消某约定时可不填"),
      replaces: z.string().min(2).max(300).nullish().describe("修改/取消某条已有约定时,填要被替换或删除的旧约定原文;纯新增则留空"),
      conversationId: z.number().nullish().describe("当前会话 ID,用于溯源")
    },
    async (args: { text?: string | null; replaces?: string | null; conversationId?: number | null }) => {
      try {
        const clean = (s?: string | null) => (s ?? "").replace(/\s*\n\s*/g, " ").replace(/^#+\s*/, "").trim();
        const text = clean(args.text);
        const replaces = clean(args.replaces);
        if (!text && !replaces) {
          return {
            content: [{ type: "text" as const, text: "没有要记的内容:请给出约定原文(text),或要取消的旧约定(replaces)。" }],
            isError: true as const
          };
        }
        const result = submitMemoryCandidate({
          text,
          replaces,
          source: "remember_convention",
          conversationId: args.conversationId ?? undefined,
        });
        let message: string;
        if (result.candidate && result.deletions.length) {
          message = `旧约定已按删除证明清理，新约定「${text}」已提交为候选；审核通过前不会进入后续提示词。`;
        } else if (result.candidate && result.duplicate) {
          message = `相同约定候选已存在，未重复提交；审核通过前不会进入后续提示词。`;
        } else if (result.candidate) {
          message = `约定「${text}」已提交为受治理候选；审核通过前不会进入后续提示词。`;
        } else if (result.deletions.length) {
          message = `已删除工作约定「${replaces}」，并生成 ${result.deletions.length} 份删除证明。`;
        } else {
          message = `没找到要替换或删除的约定「${replaces}」，记忆未改动。`;
        }
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: {
            candidateId: result.candidate?.id,
            candidateStatus: result.candidate?.approvalStatus,
            duplicate: result.duplicate,
            deletions: result.deletions,
          }
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `约定候选提交失败:${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }
  );
}
