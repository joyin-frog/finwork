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
  const steps: LogicalStep[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    const ev = item.event;
    if (ev.type === "tool_use") {
      const name = (ev.name as string | undefined) ?? "tool";
      const useId = ev.id as string | undefined;
      // 找紧接着的 tool_result（同 toolUseId 或同名且为下一个 tool_result）
      let j = i + 1;
      while (j < items.length && items[j].event.type !== "tool_result" && items[j].event.type !== "tool_use") {
        j++;
      }
      if (j < items.length && items[j].event.type === "tool_result") {
        const resEv = items[j].event;
        const resultUseId = resEv.toolUseId as string | undefined;
        // 接受：toolUseId 匹配，或 toolUseId 缺失且下一个就是 tool_result
        if (!resultUseId || resultUseId === useId) {
          steps.push({
            toolName: name,
            isError: Boolean(resEv.isError),
            durationMs: (resEv.durationMs as number | undefined) ?? 0,
            items: [item, items[j]],
          });
          i = j + 1;
          continue;
        }
      }
      // 无法配对：作为孤儿 tool_use
      steps.push({ toolName: name, isError: false, durationMs: 0, items: [item, item] });
    } else if (ev.type === "tool_result") {
      // 孤儿 tool_result（无前置 tool_use）
      const name = (ev.name as string | undefined) ?? "tool";
      steps.push({ toolName: name, isError: Boolean(ev.isError), durationMs: (ev.durationMs as number | undefined) ?? 0, items: [item, item] });
    }
    i++;
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

  // 统计各工具步数
  const countByTool = new Map<string, number>();
  for (const s of steps) {
    countByTool.set(s.toolName, (countByTool.get(s.toolName) ?? 0) + 1);
  }

  // 占比最高的工具
  let topTool = steps[0].toolName;
  let topCount = 0;
  for (const [name, cnt] of countByTool) {
    if (cnt > topCount) { topTool = name; topCount = cnt; }
  }

  const totalSteps = steps.length;
  const failCount = steps.filter((s) => s.isError).length;
  const totalMs = steps.reduce((acc, s) => acc + s.durationMs, 0);

  const label = toolLabel(topTool);
  let summary = totalSteps === 1 ? label : `${label} ×${totalSteps}`;
  if (failCount > 0) summary += ` · 含 ${failCount} 次重试`;
  if (totalMs >= 3000) {
    const s = Math.round(totalMs / 1000);
    summary += ` · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`;
  }

  return summary;
}
