import { z } from "zod/v4";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

/** 收尾时写到输出目录的声明标记(dotfile → 不被当作产物、不进时间线);成功收尾时据此清掉本回合未声明的中间文件。 */
export const FINALIZED_MARKER = ".finalized.json";

export function createFinalizeDeliverableTool(sdk: Sdk, outputDir: string) {
  return sdk.tool(
    "finalize_deliverable",
    [
      "一次回答结束、文件产物已定稿时调用,声明本次真正交付给用户的最终文件(只写文件名,可多个)。",
      "声明后,本回合内生成但未被声明的中间/试错文件会在收尾时自动清理,只留你声明的成品,保持产物目录干净。",
      "只影响本回合新生成的文件,不碰用户上传的输入、也不碰往次回答的产物;不调用则本回合产物全部保留(保守)。",
      "每次回答最多调用一次,放在最后一步。"
    ].join("\n"),
    {
      files: z
        .array(z.string().min(1))
        .min(1)
        .describe('最终交付的文件名(basename,可含中文,不要写路径或目录),如 ["科目表差异汇总.xlsx"]'),
    },
    async (args: { files: string[] }) => {
      try {
        const names = args.files.map((f) => path.basename(String(f).trim())).filter(Boolean);
        if (!names.length) {
          return { content: [{ type: "text" as const, text: "未提供有效文件名,未记录,也未做清理。" }], isError: true as const };
        }
        const markerPath = path.join(outputDir, FINALIZED_MARKER);
        let existing: string[] = [];
        if (existsSync(markerPath)) {
          try { existing = JSON.parse(readFileSync(markerPath, "utf8")) as string[]; } catch { existing = []; }
        }
        const merged = Array.from(new Set([...existing, ...names]));
        writeFileSync(markerPath, JSON.stringify(merged), "utf8");
        return {
          content: [{ type: "text" as const, text: `已记录最终交付:${names.join("、")}。本回合其余中间/试错文件将在收尾时自动清理。` }],
          structuredContent: { finalized: merged },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `声明最终产物失败:${error instanceof Error ? error.message : String(error)}` }], isError: true as const };
      }
    }
  );
}
