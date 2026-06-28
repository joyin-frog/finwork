import path from "node:path";
import type { Hook, BeforeToolResult } from "./types";
import { getToolRiskLevel } from "@/lib/agent/tools/registry";
import { getToolSummary } from "@/lib/agent/tools/renderers";

// 高风险工具确认时,除了"做什么"还要点明"会有什么后果"(尤其不可逆/锁定类),
// 让非技术财务在按"确认"前看清影响,而不是面对一句裸工具名。
const RISK_IMPACT_NOTES: Record<string, string> = {
  confirm_payroll_period: "确认后该月工资将「生效锁定」,后续累计预扣以此为基准,不可静默更改。",
  calculate_payroll_batch: "将按累计预扣预缴法计算并保存为草稿(需再次确认才生效)。",
  export_kingdee_draft: "将生成金蝶凭证草稿文件(仅草稿,不直接落账,可在金蝶内复核后过账)。",
};

/** 把高风险工具调用翻成"人话动作摘要 + 关键事实(期间/人数) + 不可逆后果 + 确认问句"。 */
function buildRiskConfirmPrompt(toolName: string, input: unknown): string {
  const summary = getToolSummary(toolName, input);
  const bare = toolName.replace(/^mcp__\w+__/, "");
  const note = RISK_IMPACT_NOTES[bare];
  return `${summary}${note ? `\n${note}` : ""}\n\n确认执行吗?`;
}

export function createAskUserQuestionHook(): Hook {
  return {
    name: "ask-user-question",
    async before(ctx): Promise<BeforeToolResult> {
      if (ctx.toolName !== "AskUserQuestion") return { action: "allow" };
      if (!ctx.resolveUserQuestion) {
        return {
          action: "deny",
          reason: "当前通道不支持交互式选择。请用一条简短文字问题询问用户。",
        };
      }
      const questions = getToolQuestions(ctx.input);
      const answers: Record<string, string> = {};
      for (const q of questions) {
        answers[q.question] = await ctx.resolveUserQuestion(q);
      }
      return { action: "allow", input: { questions, answers } };
    },
  };
}

export function createPathSafetyHook(): Hook {
  return {
    name: "path-safety",
    async before(ctx): Promise<BeforeToolResult> {
      if (!["Write", "Edit", "MultiEdit"].includes(ctx.toolName)) return { action: "allow" };
      const filePath = getToolFilePath(ctx.input);
      if (filePath && !isInsidePath(filePath, ctx.outputDir)) {
        return {
          action: "deny",
          reason: `只能把生成文件写入本次会话输出目录：${ctx.outputDir}`,
        };
      }
      return { action: "allow" };
    },
  };
}

/** 未接线工具的机制兜底:不依赖 skill 配置正确性,Bash 一律拒绝(受控执行走 run_python)。 */
export function createUnwiredToolHook(): Hook {
  const blocked = new Set(["Bash"]);
  return {
    name: "unwired-tool",
    async before(ctx): Promise<BeforeToolResult> {
      if (!blocked.has(ctx.toolName)) return { action: "allow" };
      return {
        action: "deny",
        reason: `${ctx.toolName} 未接入本产品。需要执行代码请使用 run_python(受控环境,60s 超时)。`,
      };
    },
  };
}

// Office 二进制(非文本)文件:Read/Edit 读不了(会得到"binary file"错误),改造也只能走 run_python/skill。
const BINARY_OFFICE_EXTS = new Set([".xlsx", ".xls", ".xlsm", ".docx", ".doc", ".pptx", ".ppt"]);

/** read-guard:拦住对 Office 二进制文件用 Read/Edit/Write —— 一步导到正确工具,省掉"binary file"报错+空转一轮。 */
export function createReadGuardHook(): Hook {
  return {
    name: "read-guard",
    async before(ctx): Promise<BeforeToolResult> {
      if (!["Read", "Edit", "MultiEdit", "Write"].includes(ctx.toolName)) return { action: "allow" };
      const filePath = getToolFilePath(ctx.input);
      if (!filePath) return { action: "allow" };
      const ext = path.extname(filePath).toLowerCase();
      if (!BINARY_OFFICE_EXTS.has(ext)) return { action: "allow" };
      const kind = ext.startsWith(".xls") ? "Excel" : ext.startsWith(".doc") ? "Word" : "PPT";
      const tool = ext.startsWith(".xls") ? "openpyxl/pandas" : ext.startsWith(".doc") ? "python-docx" : "python-pptx";
      return {
        action: "deny",
        reason: `${path.basename(filePath)} 是 ${kind} 二进制文件,Read/Edit 读不了它。探查结构用 run_python(${tool} 打开读),生成或改造走对应 skill(xlsx/docx/pptx);别再用 Read/Edit/Write 直接读写这个文件。`,
      };
    },
  };
}

/** stuck-guard:本回合反复试错(连续报错 / 代码执行次数过多)时断路,逼 agent 停下来求助或交付,
 * 而不是闷头烧到 maxTurns。链每请求新建 → 计数天然按回合隔离。只盯 run_python(Bash 已被 unwired 拦)。 */
export function createStuckGuardHook(): Hook {
  let pythonCalls = 0;
  let consecutiveErrors = 0;
  let interrupts = 0;
  const MAX_PY = 15;        // 单回合代码执行体量上限(超过=该和用户对一下)
  const MAX_ERR = 3;        // 连续报错
  const MAX_INTERRUPTS = 2; // 一回合最多打断 2 次,避免反复弹
  const isPython = (n: string) => n.includes("run_python");

  return {
    name: "stuck-guard",
    async before(ctx): Promise<BeforeToolResult> {
      if (!isPython(ctx.toolName)) return { action: "allow" };
      const stuck = consecutiveErrors >= MAX_ERR || pythonCalls >= MAX_PY;
      if (!stuck) return { action: "allow" };
      if (interrupts >= MAX_INTERRUPTS) {
        return { action: "deny", reason: "本回合已多次反复尝试仍无进展。立即停止重试:用 AskUserQuestion 说明卡在哪、给可选项,或如实报告并交付已完成的部分,不要再调用 run_python。" };
      }
      interrupts += 1;
      const why = consecutiveErrors >= MAX_ERR ? `连续 ${consecutiveErrors} 次执行报错` : `本回合已执行 ${pythonCalls} 次代码`;
      if (ctx.resolveUserQuestion) {
        const ans = (await ctx.resolveUserQuestion({
          header: "反复没进展",
          question: `我${why}、仍没到位。你想怎么办?回复「继续」我换个思路再试;「停下」我说明卡在哪、等你定;「先交付」我把已完成的部分先给你。`,
        })).trim();
        if (/继续|再试|换/.test(ans)) { consecutiveErrors = 0; pythonCalls = 0; return { action: "allow" }; }
        return { action: "deny", reason: `用户选择「${ans}」。停止重试:据此向用户说明卡点或交付已完成部分,不要再用同样的方式硬试 run_python。` };
      }
      return { action: "deny", reason: `${why}、仍未成功。停止重试,改用 AskUserQuestion 说明卡点并给选项,或如实报告;不要继续盲试。` };
    },
    async after(ctx) {
      if (!isPython(ctx.toolName)) return;
      pythonCalls += 1;
      if (ctx.isError) consecutiveErrors += 1; else consecutiveErrors = 0;
    },
  };
}

// 无论如何都必须经用户确认的工具(写入用户约定等不可静默的动作)
const ALWAYS_CONFIRM_TOOLS = new Set([
  "mcp__finance_worker__remember_convention",
  // P3: 公司画像写入需用户确认
  "mcp__finance_worker__update_company_profile",
]);

// Bash 由 createUnwiredToolHook 在链首 deny,无需确认门豁免。
const CONFIRM_EXEMPT_TOOLS = new Set<string>([]);

/**
 * 高风险动作确认门(工具级)。迁移到 SDK 原生 skill 后,确认不再按 skill 配置,
 * 而是按工具风险等级:high-risk 工具(批量算薪/确认薪资期间/导出金蝶凭证等)一律需用户确认。
 */
export function createRiskConfirmHook(): Hook {
  return {
    name: "risk-confirm",
    async before(ctx): Promise<BeforeToolResult> {
      if (ALWAYS_CONFIRM_TOOLS.has(ctx.toolName)) {
        if (ctx.toolName === "mcp__finance_worker__update_company_profile") {
          const patch = getProfilePatch(ctx.input);
          const keys = Object.keys(patch).filter((k) => k !== "idempotency_key");
          const prompt = keys.length
            ? `要我更新公司画像（字段：${keys.join("、")}）吗？\n\n可在「设置 → 画像」随时查看修改。`
            : "要我更新公司画像吗？";
          return { action: "confirm", prompt };
        }
        const { text, replaces } = getConventionFields(ctx.input);
        let prompt: string;
        if (text && replaces) prompt = `要我把工作约定改成「${text}」吗?(替换原来的「${replaces}」)`;
        else if (replaces) prompt = `要我删除这条工作约定吗?\n「${replaces}」`;
        else if (text) prompt = `要我记住这条工作约定吗?\n「${text}」`;
        else prompt = "要我更新工作约定吗?";
        return { action: "confirm", prompt };
      }
      if (CONFIRM_EXEMPT_TOOLS.has(ctx.toolName)) return { action: "allow" };
      const riskLevel = getToolRiskLevel(ctx.toolName);
      if (riskLevel !== "high") return { action: "allow" };
      return {
        action: "confirm",
        prompt: buildRiskConfirmPrompt(ctx.toolName, ctx.input),
      };
    },
  };
}

function getProfilePatch(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  // patch is nested under "patch" key per tool schema
  const patch = o.patch && typeof o.patch === "object" ? o.patch as Record<string, unknown> : o;
  return patch;
}

function getConventionFields(input: unknown): { text: string; replaces: string } {
  const o = (input && typeof input === "object" ? input : {}) as { text?: unknown; replaces?: unknown };
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { text: s(o.text), replaces: s(o.replaces) };
}

export function createTimingHook(
  onToolResult: (name: string, durationMs: number, isError: boolean) => void
): Hook {
  // 计时已统一在 tool-event-tracker 按 tool_use_id 配对,这里直接消费 durationMs
  return {
    name: "timing",
    async after(ctx): Promise<void> {
      onToolResult(ctx.toolName, ctx.durationMs, ctx.isError);
    },
  };
}

function getToolFilePath(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const fp = (input as { file_path?: unknown }).file_path;
  return typeof fp === "string" ? fp : "";
}

function isInsidePath(filePath: string, rootPath: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootPath);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${path.sep}`);
}

function getToolQuestions(input: unknown) {
  if (!input || typeof input !== "object" || !("questions" in input)) return [];
  const questions = (input as { questions?: unknown }).questions;
  return Array.isArray(questions)
    ? (questions as Array<{ question: string; header?: string }>)
    : [];
}
