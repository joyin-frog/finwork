import path from "node:path";
import type { Hook, BeforeToolResult } from "./types";
import { getToolRiskLevel } from "@/lib/agent/tools/registry";
import { getToolSummary } from "@/lib/agent/tools/renderers";
import { getRoleDefinition, resolveRoleScopeTools } from "@/lib/agent/roles/registry";

// 高风险工具确认时,除了"做什么"还要点明"会有什么后果"(尤其不可逆/锁定类),
// 让非技术财务在按"确认"前看清影响,而不是面对一句裸工具名。
const RISK_IMPACT_NOTES: Record<string, string> = {
  run_python: "它可以读取、修改本机文件并执行代码；请只在你理解并接受这些影响时确认。",
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
      if (questions.length === 0) return { action: "allow", input: { questions, answers: {} } };

      let answers: Record<string, string>;
      if (questions.length === 1) {
        // 单题:原路径,答案为纯文本(不回归)
        answers = { [questions[0].question]: await ctx.resolveUserQuestion(questions[0]) };
      } else {
        // 多题:一次下发(前端一个浮层左右切换),答案以 JSON 串返回,解析回填每题
        const raw = await ctx.resolveUserQuestion({ question: `需要你确认 ${questions.length} 项`, questions });
        answers = parseMultiAnswers(raw, questions);
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
      if (!filePath) return { action: "allow" };
      // CR-Q1：delivered/ 不可变区，模型工具永不写
      if (isDeliveredPath(filePath, ctx.outputDir)) {
        return {
          action: "deny",
          reason: "不能写入不可变交付目录 delivered/（正式附件只读）。",
        };
      }
      if (!isInsidePath(filePath, ctx.outputDir)) {
        return {
          action: "deny",
          reason: `只能把生成文件写入本次会话输出目录：${ctx.outputDir}`,
        };
      }
      return { action: "allow" };
    },
  };
}

/** delivered/ 与 generate/ 同级；也拒绝对 outputDir 内误建的 delivered 子路径写入。 */
function isDeliveredPath(filePath: string, outputDir: string): boolean {
  const abs = path.resolve(filePath);
  const parts = abs.split(path.sep);
  if (parts.includes("delivered")) return true;
  const genParent = path.dirname(path.resolve(outputDir));
  const deliveredRoot = path.join(genParent, "delivered");
  return abs === deliveredRoot || abs.startsWith(deliveredRoot + path.sep);
}

/**
 * 历史「未接线工具」闸。Bash 已默认放行（用户可用性要求）；
 * hook 仍挂在链上，便于日后按名拒绝其它工具。Python 仍应优先走 run_python。
 */
export function createUnwiredToolHook(): Hook {
  const blocked = new Set<string>([]);
  return {
    name: "unwired-tool",
    async before(ctx): Promise<BeforeToolResult> {
      if (!blocked.has(ctx.toolName)) return { action: "allow" };
      return {
        action: "deny",
        reason: `${ctx.toolName} 未接入本产品。需要执行 Python 请使用 run_python。`,
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

/** stuck-guard:同一工具连续同等错误且无进展时断路（CR-R2：删除成功调用次数上限）。
 * 链每请求新建 → 计数天然按回合隔离。只盯 run_python。 */
export function createStuckGuardHook(): Hook {
  let consecutiveErrors = 0;
  let lastErrorKey = "";
  let interrupts = 0;
  const MAX_ERR = 5;        // CR-R2：连续同错 ≥5 才断
  const MAX_INTERRUPTS = 2; // 一回合最多打断 2 次,避免反复弹
  const isPython = (n: string) => n.includes("run_python");

  return {
    name: "stuck-guard",
    async before(ctx): Promise<BeforeToolResult> {
      if (!isPython(ctx.toolName)) return { action: "allow" };
      const stuck = consecutiveErrors >= MAX_ERR;
      if (!stuck) return { action: "allow" };
      if (interrupts >= MAX_INTERRUPTS) {
        return { action: "deny", reason: "本回合已多次反复尝试仍无进展。立即停止重试:用 AskUserQuestion 说明卡在哪、给可选项,或如实报告并交付已完成的部分,不要再调用 run_python。" };
      }
      interrupts += 1;
      const why = `连续 ${consecutiveErrors} 次同类执行报错`;
      if (ctx.resolveUserQuestion) {
        const ans = (await ctx.resolveUserQuestion({
          header: "反复没进展",
          question: `我${why}、仍没到位。你想怎么办?回复「继续」我换个思路再试;「停下」我说明卡在哪、等你定;「先交付」我把已完成的部分先给你。`,
        })).trim();
        if (/继续|再试|换/.test(ans)) { consecutiveErrors = 0; lastErrorKey = ""; return { action: "allow" }; }
        return { action: "deny", reason: `用户选择「${ans}」。停止重试:据此向用户说明卡点或交付已完成部分,不要再用同样的方式硬试 run_python。` };
      }
      return { action: "deny", reason: `${why}、仍未成功。停止重试,改用 AskUserQuestion 说明卡点并给选项,或如实报告;不要继续盲试。` };
    },
    async after(ctx) {
      if (!isPython(ctx.toolName)) return;
      if (ctx.isError) {
        const key = String(ctx.result ?? "").slice(0, 200).replace(/\s+/g, " ").trim().toLowerCase();
        if (key && key === lastErrorKey) {
          consecutiveErrors += 1;
        } else {
          lastErrorKey = key;
          consecutiveErrors = 1;
        }
      } else {
        consecutiveErrors = 0;
        lastErrorKey = "";
      }
    },
  };
}

/**
 * 专员会话工具边界（E 刀）：MCP 工具只放行该角色职责域内的（resolveRoleScopeTools，
 * 含域内高风险工具——它们继续走后面的确认门，交互式会话可弹确认卡）；
 * 域外 MCP 工具（含 spawn_subagent——专员不越级派发，与其他角色的域工具）一律 deny。
 * 内置工具（Read/Write 等）不经此闸：沿用链上既有 hook 与 SDK 原生 PreToolUse 机制。
 */
export function createRoleScopeHook(roleId: string): Hook {
  const scope = new Set(resolveRoleScopeTools(roleId));
  const roleName = getRoleDefinition(roleId)?.name ?? roleId;
  return {
    name: "role-scope",
    async before(ctx): Promise<BeforeToolResult> {
      if (!ctx.toolName.startsWith("mcp__")) return { action: "allow" };
      if (ctx.toolName === "mcp__finance_worker__spawn_subagent") {
        return { action: "deny", reason: `专员会话不能派发其他角色。请直接完成职责内的部分；跨域需求请向用户说明，由用户转到对应专员会话或回主管会话处理。` };
      }
      // 专员会话越权转交（D2×E4）：放行 propose_transfer（不限目标角色——越权即可转任何域）。
      if (ctx.toolName === "mcp__finance_worker__propose_transfer") {
        return { action: "allow" };
      }
      // 专员会话可沉淀本角色口径（C2×E6）：放行 remember_role_convention，但锁定只能写本角色记忆
      // （roleId 是模型填的参数，不锁则专员能越权写他角记忆，破坏 C1 隔离边界）。
      if (ctx.toolName === "mcp__finance_worker__remember_role_convention") {
        const target = (ctx.input as { roleId?: unknown } | null | undefined)?.roleId;
        if (target !== roleId) {
          return { action: "deny", reason: `专员会话只能写入「${roleName}」自己的记忆，roleId 请填 "${roleId}" 后重试。` };
        }
        return { action: "allow" };
      }
      if (!scope.has(ctx.toolName)) {
        return { action: "deny", reason: `该工具超出「${roleName}」的职责与数据权限范围。请向用户说明这超出本角色边界，并建议转到对应专员会话或回主管会话处理。` };
      }
      return { action: "allow" };
    },
  };
}

// 无论如何都必须经用户确认的工具。
// remember_convention：全局约定影响所有对话，仍走事前确认。
// remember_role_convention（刀6）：角色口径静默写入 + 对话内轻提示，安全靠可见可删。
export const ALWAYS_CONFIRM_TOOLS = new Set([
  "mcp__finance_worker__remember_convention",
  // P3: 公司画像写入需用户确认(事实数据,非口径)
  "mcp__finance_worker__update_company_profile",
]);

// Bash / run_python：默认授权（不弹确认卡）；其余 high-risk 财务写操作仍确认。
const CONFIRM_EXEMPT_TOOLS = new Set<string>([
  "Bash",
  "mcp__finance_worker__run_python",
]);

/**
 * 高风险动作确认门(工具级)。迁移到 SDK 原生 skill 后,确认不再按 skill 配置,
 * 而是按工具风险等级:high-risk 工具(批量算薪/确认薪资期间/导出金蝶凭证等)一律需用户确认。
 */
export function createRiskConfirmHook(): Hook {
  return {
    name: "risk-confirm",
    async before(ctx): Promise<BeforeToolResult> {
      if (ALWAYS_CONFIRM_TOOLS.has(ctx.toolName)) {
        // 按工具名显式分发确认文案:新增 always-confirm 工具而未写文案时落到通用兜底,不会误用画像文案。
        if (ctx.toolName === "mcp__finance_worker__update_company_profile") {
          const patch = getProfilePatch(ctx.input);
          const keys = Object.keys(patch).filter((k) => k !== "idempotency_key");
          const prompt = keys.length
            ? `要我更新公司画像（字段：${keys.join("、")}）吗？\n\n可在「设置 → 画像」随时查看修改。`
            : "要我更新公司画像吗？";
          return { action: "confirm", prompt };
        }
        if (ctx.toolName === "mcp__finance_worker__remember_convention") {
          const { text, replaces } = getConventionFields(ctx.input);
          let prompt: string;
          if (text && replaces) prompt = `要我把工作约定改成「${text}」吗?(替换原来的「${replaces}」)`;
          else if (replaces) prompt = `要我删除这条工作约定吗?\n「${replaces}」`;
          else if (text) prompt = `要我记住这条工作约定吗?\n「${text}」`;
          else prompt = "要我更新工作约定吗?";
          return { action: "confirm", prompt };
        }
        return { action: "confirm", prompt: buildRiskConfirmPrompt(ctx.toolName, ctx.input) };
      }
      // 精确名或含 run_python 的 MCP 工具名一律默认放行
      if (
        CONFIRM_EXEMPT_TOOLS.has(ctx.toolName) ||
        ctx.toolName.includes("run_python")
      ) {
        return { action: "allow" };
      }
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

/**
 * 子代理边界守卫（M2·刀8）：runSubagent 路径（非专员直聊）禁止调用 propose_transfer。
 * 子代理在后台自主执行，没有前端渲染转交卡的上下文；调用后只能在结果文本里说明越权原因。
 * 参照 createRoleScopeHook 中对 spawn_subagent 的处理方式。
 */
export function createSubagentBoundaryHook(): Hook {
  return {
    name: "subagent-boundary",
    async before(ctx): Promise<BeforeToolResult> {
      if (ctx.toolName === "mcp__finance_worker__propose_transfer") {
        return {
          action: "deny",
          reason: "子代理不能发起转交。请在结果文本中说明 out_of_scope 并返回已完成的部分，由主对话或用户决定是否转交。",
        };
      }
      return { action: "allow" };
    },
  };
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

/** 多题答案:前端以 JSON 串 {问题文本: 答案} 返回;解析失败/空答 → 每题降级空串(按未确认)。 */
function parseMultiAnswers(raw: string, questions: Array<{ question: string }>): Record<string, string> {
  let parsed: Record<string, unknown> = {};
  try {
    if (raw) parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const answers: Record<string, string> = {};
  for (const q of questions) {
    answers[q.question] = typeof parsed[q.question] === "string" ? (parsed[q.question] as string) : "";
  }
  return answers;
}
