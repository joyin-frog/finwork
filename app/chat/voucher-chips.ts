/**
 * extractVoucherChips — 从回合时间线中找 export_voucher_list 工具结果，
 * 若 content JSON 含 { fileName, sheets, voucherCount } 且 fileName 与给定文件名匹配，
 * 则返回 { sheets: number, voucherCount: number }；否则返回 null（零报错）。
 *
 * 不依赖 React,可在 Node.js 环境直接导入测试。
 */

interface VoucherChips {
  sheets: number;
  voucherCount: number;
}

/** timeline item 的最小类型：只取 event 中需要的字段。 */
interface TimelineLike {
  event: {
    type: string;
    name?: string;
    content?: string;
  };
}

const TARGET_TOOLS = new Set([
  "export_voucher_list",
  "mcp__kingdee_worker__export_voucher_list",
]);

export function extractVoucherChips(
  timeline: TimelineLike[],
  fileName: string
): VoucherChips | null {
  for (const item of timeline) {
    const ev = item.event;
    if (ev.type !== "tool_result") continue;
    if (!ev.name || !TARGET_TOOLS.has(ev.name)) continue;
    if (!ev.content) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(ev.content) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (
      typeof parsed.fileName !== "string" ||
      parsed.fileName !== fileName
    ) {
      continue;
    }

    const sheets = Array.isArray(parsed.sheets)
      ? parsed.sheets.length
      : typeof parsed.sheets === "number"
        ? parsed.sheets
        : null;

    const voucherCount =
      typeof parsed.voucherCount === "number" ? parsed.voucherCount : null;

    if (sheets === null || voucherCount === null) continue;

    return { sheets, voucherCount };
  }
  return null;
}
