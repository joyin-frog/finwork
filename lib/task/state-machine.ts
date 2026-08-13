import type { CaseState } from "./contracts";

const TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  draft: ["waiting_for_input", "preflight", "canceled"],
  waiting_for_input: ["preflight", "canceled", "failed"],
  preflight: ["planned", "waiting_for_input", "failed", "canceled"],
  planned: ["running", "canceled", "failed"],
  running: ["waiting_for_human", "validating", "repairing", "finalizing", "failed", "canceled"],
  waiting_for_human: ["running", "validating", "failed", "canceled"],
  validating: ["repairing", "finalizing", "failed", "canceled"],
  repairing: ["running", "validating", "failed", "canceled"],
  finalizing: ["delivered", "repairing", "failed", "canceled"],
  delivered: [],
  failed: ["repairing"],
  canceled: [],
};

export function canTransitionCase(from: CaseState, to: CaseState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertCaseTransition(from: CaseState, to: CaseState): void {
  if (!canTransitionCase(from, to)) {
    throw new Error(`illegal case state transition: ${from} -> ${to}`);
  }
}

export function isTerminalCaseState(state: CaseState): boolean {
  return state === "delivered" || state === "canceled";
}

