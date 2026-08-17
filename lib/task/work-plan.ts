import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentIntent, AgentWorkPlanSummary } from "@/lib/agent/contracts";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import type { JsonValue } from "@/lib/capability/common";
import { toolsForCapability } from "@/lib/capability/execution-gate";
import type { TaskContractV3 } from "./contracts";

export type WorkPlanStatus = AgentWorkPlanSummary["status"];
export type WorkPlanStepStatus = AgentWorkPlanSummary["steps"][number]["status"];

type PlannedStep = {
  stepKey: string;
  title: string;
  expectedOutcome: string;
  capabilityId: string;
  userVisible?: boolean;
  blocking?: boolean;
};

export type PreflightResult = {
  capabilityId: string;
  required: boolean;
  status: "available" | "missing" | "blocked";
  candidateTools: string[];
  reason: string;
  checkedAt: string;
};

export type CreatedWorkPlan = {
  summary: AgentWorkPlanSummary;
  casePlan: {
    caseId: string;
    version: number;
    nodes: Array<{
      id: string;
      capabilityId: string;
      capabilityVersion: string;
      status: "pending" | "ready";
      input: JsonValue;
      inputHash: string;
      idempotencyKey: string;
      ordinal: number;
    }>;
    edges: Array<{ from: string; to: string; type: "depends_on" }>;
    createdAt: string;
  };
  nodeByStepKey: ReadonlyMap<string, string>;
};

export function evaluateTaskPreflight(contract: TaskContractV3, now = new Date()): PreflightResult[] {
  const checkedAt = now.toISOString();
  return contract.requiredCapabilities.map((requirement) => {
    const candidateTools = toolsForCapability(requirement.capabilityId);
    const available = candidateTools.length > 0;
    return {
      capabilityId: requirement.capabilityId,
      required: requirement.required,
      status: available ? "available" : requirement.required ? "missing" : "blocked",
      candidateTools,
      reason: available
        ? `由 ${candidateTools.join(" / ")} 提供`
        : requirement.required
          ? "当前生产能力目录没有可执行实现"
          : "可选能力当前不可用",
      checkedAt,
    };
  });
}

export function isComplexTask(input: {
  contract: TaskContractV3;
  intent?: AgentIntent;
  goal: string;
}): boolean {
  const { contract, intent, goal } = input;
  if (intent === "complex_workflow") return true;
  if (contract.inputs.length > 1 || contract.requiredCapabilities.filter((item) => item.required).length > 2) return true;
  if (contract.expectedOutputs.length > 0 || contract.humanDecisionPoints.length > 0) return true;
  return /跨(?:部门|角色|文件|表)|多步|长期|持续|综合|完整|审计|尽调|合并|预算|预测|重构|批量|分析.*并|先.*再.*(?:最后|然后)/i.test(goal);
}

export function buildWorkPlan(input: {
  caseId: string;
  runId: string;
  contract: TaskContractV3;
  intent?: AgentIntent;
  reason?: string;
  now?: Date;
}): CreatedWorkPlan {
  const createdAt = (input.now ?? new Date()).toISOString();
  const complex = isComplexTask({ contract: input.contract, intent: input.intent, goal: input.contract.goal });
  const requiredIds = new Set(
    input.contract.requiredCapabilities.filter((item) => item.required).map((item) => item.capabilityId),
  );
  const steps: PlannedStep[] = [{
    stepKey: "preflight",
    title: "检查任务条件与可用能力",
    expectedOutcome: "输入、权限、资源和必需能力均可执行",
    capabilityId: "system.preflight",
  }];

  if (input.contract.inputs.length > 0) {
    steps.push({
      stepKey: "inspect_inputs",
      title: "读取并核对输入材料",
      expectedOutcome: "关键输入已定位，范围与数据质量已确认",
      capabilityId: "workflow.inspect-inputs",
    });
  }
  if (requiredIds.has("research.web") || requiredIds.has("retrieval.search")) {
    steps.push({
      stepKey: "gather_evidence",
      title: "收集并引用所需证据",
      expectedOutcome: "关键结论有可追溯来源和精确定位",
      capabilityId: "workflow.gather-evidence",
    });
  }
  if (complex && /跨(?:部门|角色)|专员|协同|并行|subagent/i.test(input.contract.goal)) {
    steps.push({
      stepKey: "coordinate_specialists",
      title: "协调所需专业角色",
      expectedOutcome: "专业子任务完成并回收到主任务证据链",
      capabilityId: "workflow.coordinate-specialists",
    });
  }
  steps.push({
    stepKey: "execute",
    title: complex ? "执行分析与处理" : "完成请求",
    expectedOutcome: complex ? "按目标完成核心分析、计算或变更" : "形成满足请求的可核查结果",
    capabilityId: "agent.turn",
  });
  if (input.contract.expectedOutputs.length > 0) {
    steps.push({
      stepKey: "produce_outputs",
      title: "生成约定交付物",
      expectedOutcome: "交付物数量、格式和名称符合任务合同",
      capabilityId: "workflow.produce-outputs",
    });
  }
  steps.push({
    stepKey: "validate",
    title: "验证结果与证据",
    expectedOutcome: "阻断校验全部通过，未完成项被明确识别",
    capabilityId: "system.validate",
  });
  if (input.contract.expectedOutputs.length > 0) {
    steps.push({
      stepKey: "deliver",
      title: "完成受控交付",
      expectedOutcome: "不可变产物已登记并可由用户获取",
      capabilityId: "artifact.deliver",
    });
  }

  const planId = randomUUID();
  const nodeByStepKey = new Map<string, string>();
  const planSteps = steps.map((step, ordinal) => {
    const stepId = randomUUID();
    const nodeId = randomUUID();
    nodeByStepKey.set(step.stepKey, nodeId);
    return {
      step,
      stepId,
      nodeId,
      ordinal,
      status: (ordinal === 0 ? "ready" : "pending") as "ready" | "pending",
    };
  });
  const summary: AgentWorkPlanSummary = {
    planId,
    caseId: input.caseId,
    version: 1,
    goal: input.contract.goal,
    status: "active",
    steps: planSteps.map(({ step, stepId, ordinal, status }) => ({
      stepId,
      stepKey: step.stepKey,
      title: step.title,
      expectedOutcome: step.expectedOutcome,
      status,
      ordinal,
      userVisible: step.userVisible ?? true,
      blocking: step.blocking ?? true,
    })),
  };
  const nodes = planSteps.map(({ step, nodeId, ordinal, status }) => {
    const nodeInput = { planId, stepKey: step.stepKey, taskId: input.contract.id };
    return {
      id: nodeId,
      capabilityId: step.capabilityId,
      capabilityVersion: "1.0.0",
      status,
      input: nodeInput,
      inputHash: sha256Json(nodeInput),
      idempotencyKey: `${input.runId}:${step.stepKey}`,
      ordinal,
    };
  });
  return {
    summary,
    casePlan: {
      caseId: input.caseId,
      version: 1,
      nodes,
      edges: nodes.slice(1).map((node, index) => ({
        from: nodes[index]!.id,
        to: node.id,
        type: "depends_on" as const,
      })),
      createdAt,
    },
    nodeByStepKey,
  };
}

export class WorkPlanStore {
  constructor(readonly db: DatabaseSync) {}

  create(plan: CreatedWorkPlan, reason = "deterministic production planning"): AgentWorkPlanSummary {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO case_plan_versions
        (plan_id,case_id,version,goal,reason,status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,'active','deterministic',?,?)
    `).run(plan.summary.planId, plan.summary.caseId, plan.summary.version, plan.summary.goal, reason, now, now);
    const insertStep = this.db.prepare(`
      INSERT INTO case_plan_steps
        (step_id,plan_id,step_key,title,expected_outcome,status,ordinal,user_visible,blocking,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const link = this.db.prepare(`
      INSERT INTO case_plan_step_nodes(plan_id,step_id,node_id) VALUES (?,?,?)
    `);
    for (const step of plan.summary.steps) {
      insertStep.run(
        step.stepId, plan.summary.planId, step.stepKey, step.title, step.expectedOutcome,
        step.status, step.ordinal, step.userVisible ? 1 : 0, step.blocking ? 1 : 0, now,
      );
      const nodeId = plan.nodeByStepKey.get(step.stepKey);
      if (!nodeId) throw new Error(`work plan node missing: ${step.stepKey}`);
      link.run(plan.summary.planId, step.stepId, nodeId);
    }
    return this.getCurrent(plan.summary.caseId)!;
  }

  savePreflight(caseId: string, results: readonly PreflightResult[]): void {
    const insert = this.db.prepare(`
      INSERT INTO case_preflight_results
        (preflight_id,case_id,capability_id,required,status,candidate_tools_json,reason,checked_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(case_id,capability_id) DO UPDATE SET
        required=excluded.required,status=excluded.status,
        candidate_tools_json=excluded.candidate_tools_json,reason=excluded.reason,checked_at=excluded.checked_at
    `);
    for (const result of results) {
      insert.run(
        randomUUID(), caseId, result.capabilityId, result.required ? 1 : 0, result.status,
        canonicalJson(result.candidateTools), result.reason, result.checkedAt,
      );
    }
  }

  getCurrent(caseId: string): AgentWorkPlanSummary | null {
    const plan = this.db.prepare(`
      SELECT plan_id,case_id,version,goal,status
      FROM case_plan_versions WHERE case_id=?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, version DESC LIMIT 1
    `).get(caseId) as {
      plan_id: string; case_id: string; version: number; goal: string; status: WorkPlanStatus;
    } | undefined;
    if (!plan) return null;
    const steps = this.db.prepare(`
      SELECT step_id,step_key,title,expected_outcome,status,ordinal,user_visible,blocking,result_summary
      FROM case_plan_steps WHERE plan_id=? ORDER BY ordinal
    `).all(plan.plan_id) as Array<{
      step_id: string; step_key: string; title: string; expected_outcome: string;
      status: WorkPlanStepStatus; ordinal: number; user_visible: number; blocking: number; result_summary: string | null;
    }>;
    return {
      planId: plan.plan_id,
      caseId: plan.case_id,
      version: plan.version,
      goal: plan.goal,
      status: plan.status,
      steps: steps.map((step) => ({
        stepId: step.step_id,
        stepKey: step.step_key,
        title: step.title,
        expectedOutcome: step.expected_outcome,
        status: step.status,
        ordinal: step.ordinal,
        userVisible: step.user_visible === 1,
        blocking: step.blocking === 1,
        resultSummary: step.result_summary,
      })),
    };
  }

  getByRunId(runId: string): AgentWorkPlanSummary | null {
    const row = this.db.prepare("SELECT case_id FROM cases WHERE run_id=?").get(runId) as { case_id: string } | undefined;
    return row ? this.getCurrent(row.case_id) : null;
  }

  listPreflight(caseId: string): PreflightResult[] {
    const rows = this.db.prepare(`
      SELECT capability_id,required,status,candidate_tools_json,reason,checked_at
      FROM case_preflight_results WHERE case_id=? ORDER BY capability_id
    `).all(caseId) as Array<{
      capability_id: string; required: number; status: PreflightResult["status"];
      candidate_tools_json: string; reason: string; checked_at: string;
    }>;
    return rows.map((row) => ({
      capabilityId: row.capability_id,
      required: row.required === 1,
      status: row.status,
      candidateTools: JSON.parse(row.candidate_tools_json) as string[],
      reason: row.reason,
      checkedAt: row.checked_at,
    }));
  }

  setStepStatus(
    caseId: string,
    stepKey: string,
    status: WorkPlanStepStatus,
    resultSummary?: string,
  ): { from: WorkPlanStepStatus; plan: AgentWorkPlanSummary; step: AgentWorkPlanSummary["steps"][number] } | null {
    const plan = this.getCurrent(caseId);
    const current = plan?.steps.find((step) => step.stepKey === stepKey);
    if (!plan || !current || current.status === status) return null;
    if (["succeeded", "skipped", "canceled"].includes(current.status)) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE case_plan_steps SET status=?,result_summary=COALESCE(?,result_summary),updated_at=?,
        started_at=CASE WHEN ? IN ('running','verifying') THEN COALESCE(started_at,?) ELSE started_at END,
        ended_at=CASE WHEN ? IN ('succeeded','failed','skipped','canceled','interrupted') THEN ? ELSE ended_at END
      WHERE step_id=?
    `).run(status, resultSummary ?? null, now, status, now, status, now, current.stepId);
    const node = this.db.prepare(`
      SELECT node_id FROM case_plan_step_nodes WHERE plan_id=? AND step_id=?
    `).get(plan.planId, current.stepId) as { node_id: string } | undefined;
    if (node) {
      const nodeStatus = workPlanStatusToNodeStatus(status);
      this.db.prepare(`
        UPDATE case_nodes SET status=?,output_json=COALESCE(?,output_json),
          started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,
          ended_at=CASE WHEN ? IN ('succeeded','failed','skipped','canceled') THEN ? ELSE ended_at END
        WHERE node_id=?
      `).run(nodeStatus, resultSummary ? canonicalJson({ summary: resultSummary }) : null, nodeStatus, now, nodeStatus, now, node.node_id);
    }
    const updated = this.getCurrent(caseId)!;
    const step = updated.steps.find((candidate) => candidate.stepKey === stepKey)!;
    return { from: current.status, plan: updated, step };
  }

  finish(caseId: string, status: Extract<WorkPlanStatus, "completed" | "failed" | "canceled" | "interrupted">): void {
    const plan = this.getCurrent(caseId);
    if (!plan || plan.status !== "active") return;
    this.db.prepare("UPDATE case_plan_versions SET status=?,updated_at=? WHERE plan_id=?")
      .run(status, new Date().toISOString(), plan.planId);
  }
}

function workPlanStatusToNodeStatus(status: WorkPlanStepStatus): string {
  if (status === "waiting_user") return "waiting_for_human";
  if (status === "verifying") return "validating";
  if (status === "blocked" || status === "interrupted") return "failed";
  return status;
}

export function workPlanPrompt(plan: AgentWorkPlanSummary): string {
  const steps = plan.steps
    .filter((step) => step.userVisible)
    .map((step) => `${step.ordinal + 1}. [${step.status}] ${step.title} — ${step.expectedOutcome}`)
    .join("\n");
  return [
    `<work_plan plan_id="${plan.planId}" version="${plan.version}">`,
    "这是后端冻结的业务执行计划，不是隐藏推理。按顺序工作；步骤完成仅以后端工具事实、验证器和交付证据为准，不要自行宣告状态。",
    steps,
    "</work_plan>",
  ].join("\n");
}
