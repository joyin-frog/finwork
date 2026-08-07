import { buildPiPrompt, validatePiSessionLocator } from "../../../lib/agent/pi/agent-service.ts";
import { buildFinanceToolDefinitions } from "../../../lib/agent/mcp-tools/index.ts";

if (typeof buildPiPrompt !== "function" || typeof validatePiSessionLocator !== "function") {
  throw new Error("Pi main service exports missing");
}
// 45 → 49：新增 patch_workbook / check_workbook_ties / detect_data_issues /
// merge_labeled_tables（见 CONTEXT.md）。
if (buildFinanceToolDefinitions("/tmp/finwork-ar13-pi-only").length !== 49) {
  throw new Error("Pi finance catalog incomplete");
}
console.log("AR13_PI_ONLY_OK");
