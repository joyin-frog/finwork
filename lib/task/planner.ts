import { CasePlanSchema, type CasePlan } from "./contracts";

export function assertAcyclicPlan(rawPlan: CasePlan): CasePlan {
  const plan = CasePlanSchema.parse(rawPlan);
  const indegree = new Map(plan.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(plan.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of plan.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited += 1;
    for (const child of outgoing.get(id) ?? []) {
      const degree = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, degree);
      if (degree === 0) ready.push(child);
    }
  }
  if (visited !== plan.nodes.length) throw new Error("case plan contains a dependency cycle");
  return plan;
}

