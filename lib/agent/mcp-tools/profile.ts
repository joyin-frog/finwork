import { z } from "zod/v4";
import { mergeCompanyProfile, type CompanyProfile } from "@/lib/profile/file-store";
import { withIdempotency } from "@/lib/agent/tools/idempotency";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

const CompanyProfilePatchSchema = z.object({
  region: z.string().min(1).max(100).nullish().describe("公司所在地区，如「上海市松江区」"),
  zones: z.array(z.string().min(1).max(80)).nullish().describe("所在园区/开发区，如 [\"临港新片区\"]"),
  taxpayerType: z.enum(["小规模", "一般纳税人"]).nullish().describe("纳税人类型"),
  isHighTech: z.boolean().nullish().describe("是否高新技术企业"),
  industry: z.string().min(1).max(100).nullish().describe("所属行业，如「软件信息技术」"),
  scaleRevenueWan: z.number().positive().nullish().describe("年营收（万元）"),
  revenueDimensions: z.array(z.string().min(1).max(60)).nullish().describe("收入拆分维度名，如 [\"事业部\"]——经营分析下钻用"),
  extra: z.record(z.string(), z.unknown()).nullish().describe("其他补充画像字段（自由扩展）"),
}).describe("公司画像补丁；只需传要更新的字段，其余字段保持不变");

export function createUpdateCompanyProfileTool(sdk: Sdk) {
  return sdk.tool(
    "update_company_profile",
    [
      "更新公司画像（逐步补全；每次只传要更新的字段，不传的字段保持原值）。",
      "用于在对话中逐步采集公司基本信息（地区/园区/高新/纳税人类型/营收/行业等），支撑税务优惠发现和经营分析。",
      "系统会自动向用户弹出确认后才写入，无需先口头询问。",
      "画像可在「设置 → 画像」查看和修改。"
    ].join("\n"),
    {
      patch: CompanyProfilePatchSchema,
      idempotency_key: z.string().min(8).max(64).nullish().describe("幂等键（可选）"),
    },
    withIdempotency(
      "update_company_profile",
      async (args: { patch: Partial<CompanyProfile>; idempotency_key?: string | null }) => {
        try {
          const { patch } = args;
          // 过滤 null/undefined 字段（只保留显式赋值）
          const cleanPatch = Object.fromEntries(
            Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)
          ) as Partial<CompanyProfile>;

          if (Object.keys(cleanPatch).length === 0) {
            return {
              content: [{ type: "text" as const, text: "没有要更新的画像字段，请至少传一个非空字段。" }],
              isError: true as const,
            };
          }

          const merged = await mergeCompanyProfile(cleanPatch);
          const updatedKeys = Object.keys(cleanPatch).join("、");
          return {
            content: [{
              type: "text" as const,
              text: `公司画像已更新（字段：${updatedKeys}）。可在「设置 → 画像」查看完整画像。`,
            }],
            structuredContent: { updated: cleanPatch, current: merged },
          };
        } catch (error) {
          return {
            content: [{
              type: "text" as const,
              text: `画像更新失败：${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true as const,
          };
        }
      },
      { riskLevel: "medium" }
    )
  );
}
