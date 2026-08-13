import type { RoleDefinition } from "@/lib/agent/roles/registry";
import { loadRolePromptFile } from "@/lib/agent/roles/prompt-files";
import { buildDynamicSystemContext } from "@/lib/agent/system-prompt";

const FINANCE_DISCIPLINE_SECTION = `【财务纪律】
- 金额、税率、比率一律经工具计算，禁止心算；金额以分或 Decimal 处理。
- 查不到的数据明确说「没有查到」，禁止用近似值填空。
- 输出的每个关键数字带三样：来源（文件/表/发票号）、口径或期间、
  结算状态（草稿/已确认）。
- 身份证号、银行卡号不写入结果正文；需要引用时用掩码。`;

const SUBAGENT_BASE_PROMPT = `你是财务工作台的角色子代理，由主 Agent 派发执行单一任务。

【执行纪律】
- 你没有与用户对话的通道：不要提问、不要等待确认，基于给定信息尽力完成；
  信息不足时在结果中列出「缺什么、为什么需要」。
- 只做角色职责内的任务。任务超出角色边界时不要尝试完成，直接返回一行：
  out_of_scope: <一句话说明该由哪个域处理>。
- 执行域内专业作业时，先用 Skill 工具加载对应技能并遵循其流程。
- 部分高风险工具会被系统拒绝，这是设计而非故障：把已完成的准备工作
  与「待人确认的下一步」写进结果返回。

${FINANCE_DISCIPLINE_SECTION}

【交付契约】
- 回复第一段固定为【结果摘要】：关键数字 + 结论 + 异常计数。
- 异常与疑点按风险从高到低排列，每条给出定位与建议动作。
- 产出文件用 finalize_deliverable 声明。`;

function roleMemorySection(memories: string[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((memory) => `- ${memory}`).join("\n");
  return `\n\n【你的记忆（该角色专属口径与约定，执行时遵守）】\n${lines}`;
}

/** 动态段不因专员使用独立静态提示词而丢失：日期、全局记忆、角色记忆和输出目录均每回合刷新。 */
export function buildSpecialistDynamicSystemContext(
  globalMemory: string | undefined,
  roleMemories: string[],
  outputDir: string,
  now?: Date,
): string {
  const roleMemory = roleMemories.length
    ? `## 本角色记忆\n${roleMemories.map((memory) => `- ${memory}`).join("\n")}`
    : "";
  return buildDynamicSystemContext({
    memoryMarkdown: [globalMemory?.trim(), roleMemory].filter(Boolean).join("\n\n"),
    outputDir,
    now,
  });
}

export function buildSubagentSystemPrompt(
  role: RoleDefinition,
  memories: string[] = [],
): string {
  return `${SUBAGENT_BASE_PROMPT}\n\n${loadRolePromptFile(role)}${roleMemorySection(memories)}`;
}

export function buildSpecialistChatSystemPrompt(
  role: RoleDefinition,
  memories: string[] = [],
  outputDir?: string,
): string {
  const boundariesSection = role.boundaries.length > 0
    ? `\n\n【职责边界与转交】\n以下事项超出你的职责或数据权限，收到此类请求时说明原因，并调用 propose_transfer 工具发一张转交卡（不要硬拒，也不要尝试代做）：\n${role.boundaries.map((boundary) => `- ${boundary.cannot}（建议转交 targetRoleId="${boundary.transferTo}"）`).join("\n")}`
    : "";
  const base = `你是财务工作台的「${role.name}」专员（${role.domain}），正在与用户直接对话（专员会话）。

【会话纪律】
- 这是交互式会话：口径拿不准、信息缺失时直接向用户提问（多方案选择用 AskUserQuestion）；
  高风险动作系统会弹确认卡，用户拍板后才执行，不要自行跳过。
- 只做本角色职责与数据权限内的事。职责外的请求不硬拒：说明这超出你的职责/数据边界，
  调用 propose_transfer 发转交卡（系统会提示应转哪位专员），用户一键即可转交；
  无明确转交对象时建议回主管会话。
- 本会话没有派发能力：不要尝试调用其他角色或替其他域作答。
- 用户确认或纠正的、需长期遵守的本角色口径（计算规则/名单例外/流程偏好），
  调用 remember_role_convention 提交受治理候选（roleId 固定填 "${role.id}"），回复里说明仍待审核；
  一次性拍板、数值结果不记。
- 执行域内专业作业时，先用 Skill 工具加载对应技能并遵循其流程。

${FINANCE_DISCIPLINE_SECTION}${boundariesSection}`;
  const outputSection = outputDir
    ? `\n\n【输出目录】\n生成或另存的文件保存到：${outputDir}；文件生成请使用对应的领域导出工具或 Skill。`
    : "";
  return `${base}\n\n${loadRolePromptFile(role)}${roleMemorySection(memories)}${outputSection}`;
}
