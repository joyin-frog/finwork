/**
 * POST /api/agents/dispatches/[id]/start — 启动排队中的转交任务（D3·刀8）
 *
 * 将 status='queued' 的行 CAS 转为 'running'，然后异步执行 runSubagent。
 * dispatch 行的生命周期（running→success/failed + ended_at + duration_ms）
 * 完全交给 runSubagent 内部的 recordDispatchStart/recordDispatchEnd 管理；
 * 本端点只负责 CAS 抢占 + D4 回写来源会话（insertChatMessage）。
 *
 * 注意（L2）：本端点不做来源会话绑定校验——originConversationId 由 propose_transfer 工具在
 * structuredContent 里写入，转交卡前端 POST /api/agents/transfer 落库；此处只透传，不验证
 * 来源会话的所有权或当前状态（桌面单机环境，会话即本机本人所有）。
 *
 * 注意（L4）：fire-and-forget 依赖桌面常驻进程（Next.js dev/server 一直跑）；
 * 若进程在执行期间退出，任务会停留在 status='running' 而无 ended_at，
 * 需人工清理或下次重启时对账。Serverless 环境不适用，需换队列方案。
 *
 * 响应码：
 * - 202：已接受，任务正在后台启动
 * - 404：行不存在
 * - 409：行非 queued 状态（已在运行中或已完成）
 * - 400：行存在但 instructions / role_id 为空，无法构建任务
 */

import { NextResponse } from "next/server";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { getDispatchById, startQueuedDispatch } from "@/lib/db/dispatch-store";
import { insertChatMessage } from "@/lib/db/sqlite";
import { getAppDataDir } from "@/lib/runtime/paths";
import { getRoleDefinition } from "@/lib/agent/roles/registry";
import { getDisabledRoleIds } from "@/lib/agent/roles/availability";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);

  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "无效 id" }, { status: 400 });
  }

  const row = getDispatchById(id);
  if (!row) {
    return NextResponse.json({ error: "派发记录不存在" }, { status: 404 });
  }
  if (row.status !== "queued") {
    return NextResponse.json(
      { error: `该任务不在排队状态（当前：${row.status}）` },
      { status: 409 }
    );
  }
  if (!row.instructions) {
    return NextResponse.json({ error: "排队任务缺少 instructions，无法启动" }, { status: 400 });
  }

  const role = getRoleDefinition(row.roleId);
  if (!role) {
    return NextResponse.json({ error: `未知角色 "${row.roleId}"` }, { status: 400 });
  }
  // 必须在 CAS 抢占之前校验：runSubagent 对不可派发角色会早返回且不写
  // recordDispatchEnd，若已把行标成 running 会永久卡住。
  if (!role.available) {
    return NextResponse.json(
      { error: `角色「${role.name}」尚未启用，无法启动排队任务` },
      { status: 400 }
    );
  }
  if (getDisabledRoleIds().includes(row.roleId)) {
    return NextResponse.json(
      {
        error: `角色「${role.name}」已停用，无法启动排队任务。请先在「智能体」页面启用该专员`,
      },
      { status: 400 }
    );
  }

  // CAS: queued → running（乐观并发：两个请求同时到达时只有一个成功）
  const grabbed = startQueuedDispatch(id);
  if (!grabbed) {
    return NextResponse.json({ error: "任务已被并发启动，请刷新后重试" }, { status: 409 });
  }

  // 立即返回 202，异步执行（fire-and-forget，参见头部 L4 说明）
  const outputDir = path.join(getAppDataDir(), "transfer-queue", String(id));
  mkdirSync(outputDir, { recursive: true });

  void (async () => {
    try {
      const { runSubagent } = await import("@/lib/agent/subagent-runner");
      // existingDispatchId: 传入已有的 dispatch 行 id，runSubagent 内部直接复用，
      // 不再调用 recordDispatchStart 插入新行（B1·刀8：防止双台账行）。
      // dispatch 行生命周期（running→success/failed）由 runSubagent 内部管理。
      const result = await runSubagent(
        {
          roleId: row.roleId,
          instructions: row.instructions!,
          label: row.label ?? `转交任务 #${id}`,
          existingDispatchId: id,
        },
        { parentOutputDir: outputDir }
      );

      // D4: 向来源会话回写结果（来源会话可能已被删除，catch 静默）
      const originConvId = row.conversationId ? Number(row.conversationId) : null;
      if (originConvId && Number.isFinite(originConvId)) {
        const statusLabel = result.success ? "完成" : "失败";
        const msgContent = `【转交任务${statusLabel}】${role.name} · ${row.label ?? `#${id}`}\n${result.content.slice(0, 400)}`;
        try {
          insertChatMessage(originConvId, "assistant", msgContent);
        } catch {
          // 来源会话可能已被删除；不影响主流程
        }
      }
    } catch {
      // runSubagent 本身通常不抛异常（内部已 catch 并返回 SubagentResult），
      // 此处兜底未预期的抛出；dispatch 行此时 status='running' 无 ended_at，
      // 需人工清理（见 L4 说明）。
    }
  })();

  return NextResponse.json({ ok: true, data: { dispatchId: id, status: "running" } }, { status: 202 });
}
