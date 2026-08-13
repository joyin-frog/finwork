import type { CaseDeadline } from "./contracts";

export type DeadlineAction = {
  deadlineId: string;
  caseId: string;
  kind: "reminder" | "overdue";
  dueAt: string;
};

/** Pure scheduler: the caller persists actions and delivers notifications. */
export function evaluateDeadlines(deadlines: readonly CaseDeadline[], now = new Date()): DeadlineAction[] {
  const nowMs = now.getTime();
  const actions: DeadlineAction[] = [];
  for (const deadline of deadlines) {
    if (deadline.status !== "scheduled") continue;
    const dueMs = Date.parse(deadline.dueAt);
    if (dueMs <= nowMs) {
      actions.push({ deadlineId: deadline.id, caseId: deadline.caseId, kind: "overdue", dueAt: deadline.dueAt });
      continue;
    }
    if (deadline.remindAt && Date.parse(deadline.remindAt) <= nowMs) {
      actions.push({ deadlineId: deadline.id, caseId: deadline.caseId, kind: "reminder", dueAt: deadline.dueAt });
    }
  }
  return actions;
}
