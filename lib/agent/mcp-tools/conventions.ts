import { z } from "zod/v4";
import { reviseMemorySection } from "@/lib/memory/file-store";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

export function createRememberConventionTool(sdk: Sdk) {
  return sdk.tool(
    "remember_convention",
    [
      "管理用户的长期工作约定(记忆文件的工作约定节,之后每次对话自动遵守,设置 → 记忆 可查看修改)。",
      "新增:用户表达想长期遵守的规矩/偏好时,text 一句话忠实转述,不要扩写(例:\"以后报销超 2000 都提醒我\"\"发薪日是 10 号\"\"报表都要带环比\")。",
      "修改/取消既有约定:把要被替换或取消的旧约定原文填进 replaces(工具会先删掉旧的);改成新规矩就同时给 text,纯取消就只填 replaces、不要新增否定句——别再追加互相矛盾的条目。",
      "系统会自动向用户弹出确认,确认通过才会写入,无需先口头询问。仅用于跨对话长期生效的规矩;一次性指令不要调用。"
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
        const date = new Date().toISOString().slice(0, 10);
        const { removed, added } = await reviseMemorySection("## 工作约定", {
          addLine: text ? `- [${date}] ${text}` : undefined,
          removeMatch: replaces || undefined,
        });

        // 如实复述实际发生了什么(不再凭感觉说"已更新",红线 4)
        let message: string;
        if (added && removed.length) {
          message = `已更新工作约定:删除「${removed.join("」「")}」,改记「${added}」。可在 设置 → 记忆 查看修改。`;
        } else if (added) {
          message = `已记住这条约定:「${added}」。之后处理相关任务我会自动遵守;可在 设置 → 记忆 查看或修改。`;
        } else if (removed.length) {
          message = `已删除工作约定:「${removed.join("」「")}」,以后不再按此处理。可在 设置 → 记忆 查看。`;
        } else {
          message = `没找到要替换/删除的约定「${replaces}」,记忆未改动。可在 设置 → 记忆 查看现有约定。`;
        }
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: { added, removed, date }
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `约定保存失败:${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }
  );
}
