/**
 * step-aggregate.ts — 纯函数，对 turn-segments 的 tools 段做失败聚合与分组摘要。
 *
 * 设计原则：
 * - 连续 ≥2 个「同工具名且 isError」的 tool_use/tool_result 对 → 合成 retry-group；
 * - recovered = 该组之后（同段内）存在同工具的成功步；
 * - 单个失败步：之后同段内有同工具成功 → degraded=true；
 * - 其余原样透传 kind:"step"。
 */

import type { SegmentTimelineItem } from "./turn-segments";
import { getToolSummary } from "@/lib/agent/tools/renderers";

export type AggregatedStep =
  | { kind: "step"; item: SegmentTimelineItem; degraded: boolean }
  | { kind: "retry-group"; toolName: string; label: string; count: number; recovered: boolean; items: SegmentTimelineItem[] };

// ─── 内部：把 tool_use/tool_result 事件流拆成「逻辑步」 ───────────────────

type LogicalStep = {
  toolName: string;
  isError: boolean;
  durationMs: number;
  items: [SegmentTimelineItem, SegmentTimelineItem]; // [tool_use, tool_result]
};

/** 将原始 SegmentTimelineItem 流(含 tool_use + tool_result)按成对方式解析成逻辑步。
 * 配对策略：tool_use 之后紧接着同工具名(或 toolUseId 匹配)的 tool_result。
 * 无法配对的孤儿事件包装为单独逻辑步(isError=false, durationMs=0)。 */
function parseLogicalSteps(items: SegmentTimelineItem[]): LogicalStep[] {
  // 并行批量调用时事件序是 u,u,u,u,r,r,r,r(而非 u,r 相邻),相邻配对会整段错位、
  // 产出成排孤儿"执行失败"行。配对以 toolUseId 为准;无 id 的 result 回退到
  // "后续第一个未认领的同名 result"。步骤顺序跟随 tool_use 的时序。
  const resultByUseId = new Map<string, SegmentTimelineItem>();
  for (const it of items) {
    const ev = it.event;
    const useId = ev.type === "tool_result" ? (ev.toolUseId as string | undefined) : undefined;
    if (useId && !resultByUseId.has(useId)) resultByUseId.set(useId, it);
  }

  const steps: LogicalStep[] = [];
  const consumed = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ev = item.event;
    if (ev.type === "tool_use") {
      const name = (ev.name as string | undefined) ?? "tool";
      const useId = ev.id as string | undefined;
      let match: SegmentTimelineItem | undefined = useId ? resultByUseId.get(useId) : undefined;
      if (!match) {
        // 无 id 关联:向后找第一个未认领、自身也无 toolUseId 的同名 result
        for (let j = i + 1; j < items.length; j++) {
          const rev = items[j].event;
          if (
            rev.type === "tool_result" && !consumed.has(items[j].id) &&
            !rev.toolUseId && ((rev.name as string | undefined) ?? "tool") === name
          ) { match = items[j]; break; }
        }
      }
      if (match && !consumed.has(match.id)) {
        consumed.add(match.id);
        const resEv = match.event;
        steps.push({
          toolName: name,
          isError: Boolean(resEv.isError),
          durationMs: (resEv.durationMs as number | undefined) ?? 0,
          items: [item, match],
        });
      } else {
        // 无法配对：作为孤儿 tool_use(进行中或 result 丢失)
        steps.push({ toolName: name, isError: false, durationMs: 0, items: [item, item] });
      }
    } else if (ev.type === "tool_result" && !consumed.has(item.id)) {
      // 真孤儿 tool_result(它的 use 不在本段):保留可见
      consumed.add(item.id);
      const name = (ev.name as string | undefined) ?? "tool";
      steps.push({ toolName: name, isError: Boolean(ev.isError), durationMs: (ev.durationMs as number | undefined) ?? 0, items: [item, item] });
    }
  }
  return steps;
}

/** 对逻辑步数组：某工具名在 fromIndex 之后是否有成功步。 */
function hasSuccessAfter(steps: LogicalStep[], fromIndex: number, toolName: string): boolean {
  for (let i = fromIndex; i < steps.length; i++) {
    if (steps[i].toolName === toolName && !steps[i].isError) return true;
  }
  return false;
}

/** 取工具的人话标签（中文名）：复用 renderers 的 getToolSummary，传空 input 取动词部分，剥引号。 */
function toolLabel(toolName: string): string {
  const raw = getToolSummary(toolName, {});
  // 去掉「：…」后缀（仅要动词/名词部分）
  const base = raw.split(/[:：]/)[0].replace(/[「『」』]/g, "").trim();
  return base || toolName;
}

/**
 * @param laterItems 本回合中位于该段之后的事件(跨段)。真实数据里失败与重试成功常被
 * thinking 段隔开而落进不同 tools 段,只看段内会把"已恢复"误判成终局失败(保红)。
 */
export function aggregateToolSegment(items: SegmentTimelineItem[], laterItems: SegmentTimelineItem[] = []): AggregatedStep[] {
  if (!items.length) return [];

  const steps = parseLogicalSteps(items);
  // 跨段成功工具集:该段之后任何位置成功过的工具,失败即视为已恢复
  const laterSuccess = new Set(
    parseLogicalSteps(laterItems).filter((s) => !s.isError).map((s) => s.toolName)
  );
  const result: AggregatedStep[] = [];
  let i = 0;

  while (i < steps.length) {
    const step = steps[i];

    if (!step.isError) {
      // 成功步原样透传
      result.push({ kind: "step", item: step.items[0], degraded: false });
      i++;
      continue;
    }

    // 失败步：向前看连续同工具失败的长度
    const toolName = step.toolName;
    let runEnd = i + 1;
    while (runEnd < steps.length && steps[runEnd].toolName === toolName && steps[runEnd].isError) {
      runEnd++;
    }
    const runLen = runEnd - i;

    if (runLen >= 2) {
      // 聚合为 retry-group
      const recovered = hasSuccessAfter(steps, runEnd, toolName) || laterSuccess.has(toolName);
      const groupItems = steps.slice(i, runEnd).flatMap((s) =>
        s.items[0] === s.items[1] ? [s.items[0]] : [s.items[0], s.items[1]]
      );
      const label = `${toolLabel(toolName)} 重试 ×${runLen}`;
      result.push({ kind: "retry-group", toolName, label, count: runLen, recovered, items: groupItems });
      i = runEnd;
    } else {
      // 单个失败步
      const degraded = hasSuccessAfter(steps, i + 1, toolName) || laterSuccess.has(toolName);
      result.push({ kind: "step", item: step.items[0], degraded });
      i++;
    }
  }

  return result;
}

/** 组/段摘要：给一串逻辑步生成确定性中文摘要。
 * 规则：取占比最高的工具中文名 + 步数；有失败加「含 N 次重试」；总时长(sum durationMs) ≥3s 时附加。 */
export function summarizeToolSegment(items: SegmentTimelineItem[]): string {
  if (!items.length) return "";

  const steps = parseLogicalSteps(items);
  if (!steps.length) return "";

  // 各工具动词标签,按首次出现序去重
  const distinctLabels: string[] = [];
  for (const s of steps) {
    const l = toolLabel(s.toolName);
    if (!distinctLabels.includes(l)) distinctLabels.push(l);
  }

  const totalSteps = steps.length;
  const failCount = steps.filter((s) => s.isError).length;
  const totalMs = steps.reduce((acc, s) => acc + s.durationMs, 0);

  let summary: string;
  if (distinctLabels.length === 1) {
    // 同质组:动词 ×N：对象列表(取各步 renderer 文案的对象部分,去重取前 2)
    summary = totalSteps === 1 ? distinctLabels[0] : `${distinctLabels[0]} ×${totalSteps}`;
    const objects: string[] = [];
    for (const s of steps) {
      const input = (s.items[0].event as { input?: Record<string, unknown> }).input ?? {};
      const raw = getToolSummary(s.toolName, input);
      const m = raw.match(/[:：](.+)$/);
      let obj = m ? m[1] : raw.startsWith(toolLabel(s.toolName)) ? raw.slice(toolLabel(s.toolName).length) : "";
      obj = obj.replace(/[「『」』]/g, "").trim();
      if (obj && !objects.includes(obj)) objects.push(obj);
    }
    if (objects.length > 0) {
      const shown = objects.slice(0, 2).map((o) => (o.length > 14 ? `${o.slice(0, 14)}…` : o));
      summary += `：${shown.join("、")}${objects.length > 2 ? "…" : ""}`;
    }
  } else if (distinctLabels.length <= 3) {
    // 混合 ≤3 种:动词列举(不冒用占比最高的名字);步数=种类数时 ×N 是废话,省略。
    // 不给对象列表——不同动词的对象混排会误导。
    summary = distinctLabels.join("、") + (totalSteps > distinctLabels.length ? ` ×${totalSteps}` : "");
  } else {
    // 混合 >3 种:首动词 等 ×N
    summary = `${distinctLabels[0]} 等 ×${totalSteps}`;
  }

  if (failCount > 0) summary += ` · 含 ${failCount} 次重试`;
  if (totalMs >= 3000) {
    const s = Math.round(totalMs / 1000);
    summary += ` · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`;
  }

  return summary;
}
