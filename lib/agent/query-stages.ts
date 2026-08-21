/**
 * WP10a：POST 本体四段管线
 *
 * Stage<In,Out> = (ctx: In) => Promise<Out | Response>
 * 返回 Response 即短路（直接返回给客户端，后续段跳过）。
 *
 * 纯平移：代码从 app/api/agent/query/route.ts 对应行段搬入，禁止顺手改写。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isEnabled } from "@/lib/runtime/flags";
import type { AgentAttachment, AgentMessage } from "@/lib/agent/contracts";
import { sanitizeAttachments } from "@/lib/agent/attachment-guard";
import {
  createChatConversation,
  getChatConversation,
  getDb,
  getMessageAttachments,
  insertChatAttachment,
  insertChatMessage,
  insertChatMessageWorkspaceRoots,
} from "@/lib/db/sqlite";
import { getConversationFilesDir, getRunFileWorkspaceDir, getRunFileWorkspacePaths } from "@/lib/runtime/paths";
import { getFileWorkspaceStore } from "@/lib/file-workspace";
import { snapshotGeneratedFiles, snapshotWorkingFiles } from "@/lib/chat/generated-files";
import { matchTrivialMessage, normalizeTier, resolveModelByTier, runRouter } from "@/lib/agent/router";
import { specialistRoleUsabilityIssue } from "@/lib/agent/roles/availability";
import { injectSkillHint } from "@/lib/agent/skill-hint";
import { getUsageStatus } from "@/lib/usage/store";
import { buildBlockedNotice } from "@/lib/usage/quota";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { createLogger } from "@/lib/runtime/logger";

const log = createLogger("agent-query");

/** 附件超过服务端大小上限时抛出此错误（带类型标记，便于 catch 分支精确识别）。 */
class AttachmentTooLargeError extends Error {
  readonly type = "AttachmentTooLarge" as const;
  constructor(actualBytes: number, limitBytes: number) {
    const actualMB = (actualBytes / (1024 * 1024)).toFixed(1);
    const limitMB = (limitBytes / (1024 * 1024)).toFixed(0);
    super(`附件大小 ${actualMB}MB 超过上限 ${limitMB}MB，请精简后重试`);
    this.name = "AttachmentTooLargeError";
  }
}

export type Stage<In, Out> = (ctx: In) => Promise<Out | Response>;

// ─── Stage 1: parseStage ─────────────────────────────────────────────────────
// 解析请求体 + attachment 安全守卫（route.ts 40-84 段）

export type ParseInput = {
  request: Request;
  traceId: string;
  startedAt: number;
  settings: Awaited<ReturnType<typeof readAgentSettings>>;
  roleMode: string;
};

export type ParseOutput = ParseInput & {
  messages: AgentMessage[];
  conversationId: number | undefined;
  attachments: AgentAttachment[];
  referencedSkills: string[];
  modelTier: string | undefined;
  lastUserContent: string;
  useStreaming: boolean;
  requestSignal: AbortSignal | undefined;
  /** 专员会话（E 刀）：客户端请求的角色 id（已校验存在），仅在创建新会话时生效。 */
  roleParam: string | undefined;
  workspaceRootIds: string[];
};

export const parseStage: Stage<ParseInput, ParseOutput> = async (ctx) => {
  const { request, traceId } = ctx;

  let messages: AgentMessage[];
  let conversationId: number | undefined;
  let attachments: AgentAttachment[] = [];
  let referencedSkills: string[] = [];
  let modelTier: string | undefined;
  let roleParam: string | undefined;
  let workspaceRootIds: string[] = [];

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const parsed = await parseMultipartRequest(request, traceId);
      messages = parsed.messages;
      conversationId = parsed.conversationId;
      attachments = parsed.attachments;
      referencedSkills = parsed.referencedSkills;
      modelTier = parsed.modelTier;
      roleParam = parsed.roleParam;
      workspaceRootIds = parsed.workspaceRootIds;
    } else {
      const parsed = await parseJsonRequest(request, traceId);
      messages = parsed.messages;
      conversationId = parsed.conversationId;
      attachments = parsed.attachments;
      referencedSkills = parsed.referencedSkills;
      modelTier = parsed.modelTier;
      roleParam = parsed.roleParam;
      workspaceRootIds = parsed.workspaceRootIds;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("parse failed", { traceId, error });
    return new Response(JSON.stringify({ ok: false, error: `请求解析失败: ${message}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 安全护栏:客户端提交的 attachments.storagePath 完全可控,会被拼进 agent 提示("路径: …")
  // 且 Read/read_document 无路径限制 —— 不校验就能诱导 agent 读任意文件。丢弃逃逸出会话目录的附件。
  {
    const { kept, dropped } = sanitizeAttachments(attachments, conversationId, [getRunFileWorkspaceDir(traceId)]);
    if (dropped.length) {
      log.warn("dropped out-of-scope attachments", { traceId, count: dropped.length, names: dropped.map((a) => a.name) });
      attachments = kept;
    }
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUserMessage?.content.trim() ?? "";
  log.info("payload parsed", { traceId, conversationId: conversationId ?? null, messageCount: messages.length, attachmentCount: attachments.length });

  const useStreaming = shouldUseStreaming(request);

  return {
    ...ctx,
    messages,
    conversationId,
    attachments,
    referencedSkills,
    modelTier,
    lastUserContent,
    useStreaming,
    requestSignal: request.signal,
    roleParam,
    workspaceRootIds,
  };
};

// ─── Stage 2: sessionStage ───────────────────────────────────────────────────
// 会话管理 + user 消息落库 + staleness 检查（route.ts 86-122 段）

export type SessionInput = ParseOutput;

export type SessionOutput = SessionInput & {
  existingRuntimeSessionId: string | null;
  runtimeSessionId: string | null;
  agentMessages: AgentMessage[];
  outputDir: string | undefined;
  beforeGenerate: Set<string>;
  beforeWorking: Set<string>;
  modelOverride: string | undefined;
  /** 专员会话（E 刀）：本会话绑定的角色 id（服务端以 DB 行为准）；NULL = 主管会话。 */
  sessionRoleId: string | null;
};

export const sessionStage: Stage<SessionInput, SessionOutput> = async (ctx) => {
  const { traceId, messages, attachments, conversationId: ctxConversationId, lastUserContent, referencedSkills, modelTier, settings } = ctx;

  let conversationId = ctxConversationId;
  let conversation = conversationId ? getChatConversation(conversationId) : null;

  // 既有专员会话：每回合复检可用面——停用后禁止静默回落主管（与派发 fail-closed 一致）。
  if (conversation?.roleId) {
    const issue = specialistRoleUsabilityIssue(conversation.roleId);
    if (issue) {
      log.warn("specialist session blocked", { traceId, conversationId, roleId: conversation.roleId, issue });
      const { NextResponse } = await import("next/server");
      return NextResponse.json({ ok: false, error: issue }, { status: 403 });
    }
  }

  if (lastUserContent) {
    let skipInsert = false;
    let dedupMessageId: number | undefined;
    if (!conversationId) {
      const shortTitle = generateShortTitle(lastUserContent);
      // 专员会话（E 刀）：role 参数只在创建新会话时生效；非法 role 显式失败，禁止静默建主管会话。
      let createRoleId: string | null = null;
      if (ctx.roleParam) {
        const issue = specialistRoleUsabilityIssue(ctx.roleParam);
        if (issue) {
          log.warn("reject invalid specialist role on create", { traceId, role: ctx.roleParam, issue });
          const { NextResponse } = await import("next/server");
          return NextResponse.json({ ok: false, error: issue }, { status: 400 });
        }
        createRoleId = ctx.roleParam;
      }
      conversationId = createChatConversation(shortTitle, createRoleId);
      conversation = getChatConversation(conversationId);
      log.info("conversation created", { traceId, conversationId, title: shortTitle, roleId: conversation?.roleId ?? null });
    } else {
      // 去重：若会话最后一条是同内容的 user 消息，跳过 insert（重试场景防双写）
      const lastMsg = getDb()
        .prepare("SELECT id, role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1")
        .get(conversationId) as { id: number; role: string; content: string } | undefined;
      if (lastMsg && lastMsg.role === "user" && lastMsg.content === lastUserContent) {
        log.info("user message dedup skipped", { traceId, conversationId });
        skipInsert = true;
        dedupMessageId = lastMsg.id;
      }
    }
    if (!skipInsert) {
      const db = getDb();
      db.exec("BEGIN");
      try {
        const messageId = insertChatMessage(conversationId, "user", lastUserContent);
        insertChatMessageWorkspaceRoots(messageId, ctx.workspaceRootIds);
        for (const att of attachments) {
          if ((att.storagePath || att.assetId) && conversationId) {
            insertChatAttachment({
              id: randomUUID(), messageId,
              fileName: att.name, mimeType: att.mimeType, sizeBytes: att.size,
              storagePath: att.assetId ? logicalAssetPath(att.assetId, att.name) : path.relative(getConversationFilesDir(conversationId), att.storagePath!),
              assetId: att.assetId ?? null,
              assetVersionId: att.versionId ?? null,
              role: "user"
            });
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
    }
    if (skipInsert && dedupMessageId !== undefined) {
      insertChatMessageWorkspaceRoots(dedupMessageId, ctx.workspaceRootIds);
      // 去重命中但新附件仍需落库：防止附件成为 DB 孤儿文件（Plan 045）
      const existing = getMessageAttachments(dedupMessageId);
      const toInsert = attachments.filter(
        (att) =>
          (att.storagePath || att.assetId) &&
          conversationId &&
          !existing.some((e) => e.fileName === att.name && e.sizeBytes === att.size)
      );
      if (toInsert.length > 0) {
        const db = getDb();
        db.exec("BEGIN");
        try {
          for (const att of toInsert) {
            if ((att.storagePath || att.assetId) && conversationId) {
              insertChatAttachment({
                id: randomUUID(), messageId: dedupMessageId,
                fileName: att.name, mimeType: att.mimeType, sizeBytes: att.size,
                storagePath: att.assetId ? logicalAssetPath(att.assetId, att.name) : path.relative(getConversationFilesDir(conversationId), att.storagePath!),
                assetId: att.assetId ?? null,
                assetVersionId: att.versionId ?? null,
                role: "user"
              });
            }
          }
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
          throw error;
        }
        log.info("dedup hit, attached new files to existing message", { traceId, conversationId, count: toInsert.length });
      }
    }
  }

  // Session staleness check
  const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  let existingRuntimeSessionId = conversation?.runtimeSessionId ?? null;
  if (isEnabled("SESSION_LIVENESS_CHECK_ENABLED") && existingRuntimeSessionId && conversation?.runtimeSessionUpdatedAt) {
    if (Date.now() - new Date(conversation.runtimeSessionUpdatedAt).getTime() > SESSION_MAX_AGE_MS) {
      log.info("session stale", { traceId, conversationId });
      existingRuntimeSessionId = null;
    }
  }
  // locator 归 runtime 所有，Query 只搬运不铸造（见 lib/agent/session.ts）。Pi 的 locator
  // 就是受控目录里的 .jsonl 路径，自铸 UUID 落库会在回合中途失败时留下永久卡死 resume 的
  // 假 locator。首轮为 null，真实 locator 由回合结束时的回写填入。
  const runtimeSessionId = conversationId ? existingRuntimeSessionId : null;

  // 用户引用的技能 → 注入"优先使用这些技能"提示(只改发给 agent 的副本,不污染已落库原文)。
  const agentMessages = injectSkillHint(messages, referencedSkills); // 裁剪职责下沉到 adapter（pickPromptMessages）
  const runPaths = getRunFileWorkspacePaths(traceId);
  const outputDir = conversationId ? runPaths.work : undefined;
  if (outputDir) {
    for (const dir of [runPaths.inputs, runPaths.work, runPaths.outputs]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
  const beforeGenerate = snapshotGeneratedFiles(conversationId);
  const beforeWorking = snapshotWorkingFiles(outputDir);
  const modelOverride = resolveModelByTier(normalizeTier(modelTier), settings);

  return {
    ...ctx,
    conversationId,
    existingRuntimeSessionId,
    runtimeSessionId,
    agentMessages,
    outputDir,
    beforeGenerate,
    beforeWorking,
    modelOverride,
    sessionRoleId: conversation?.roleId ?? null,
  };
};

// ─── Stage 3: quotaStage ─────────────────────────────────────────────────────
// 用量配额拦截（route.ts 131-149 段）

export type QuotaInput = SessionOutput;
export type QuotaOutput = QuotaInput;

export const quotaStage: Stage<QuotaInput, QuotaOutput> = async (ctx) => {
  const { traceId, lastUserContent, conversationId, useStreaming, settings } = ctx;

  // --- 用量配额拦截:在 router/agent 之前,任何 LLM 花费前 ---
  if (isEnabled("USAGE_LIMIT_ENABLED") && lastUserContent) {
    const usage = getUsageStatus({
      now: Date.now(),
      roles: {
        fastModel: settings.fastModel ?? "",
        reasoningModel: settings.reasoningModel ?? "",
      },
      // 放行即把(过期则重锚的)窗口起点写回,使紧随其后的本回合 trace 落在窗口内。
      // 命中拦截时窗口必为活动态,重锚为 no-op,落库无副作用。
      persist: true,
    });
    const notice = buildBlockedNotice(usage);
    if (notice) {
      log.info("usage blocked", { traceId, window: notice.window, resetAt: notice.resetAt });
      // 平移自 route.ts buildUsageBlockedResponse：避免循环依赖，直接内联落库+响应逻辑
      const { insertChatMessage: insertMsg, insertChatAgentEvent: insertEvt } = await import("@/lib/db/sqlite");
      const { sanitizeTurnEvents } = await import("@/lib/agent/persist-hygiene");
      const { getChatConversation: getConv } = await import("@/lib/db/sqlite");
      if (conversationId) {
        const messageId = insertMsg(conversationId, "assistant", notice.message);
        const evts = sanitizeTurnEvents([
          { type: "system", subtype: "usage_blocked", message: notice.message, resetAt: notice.resetAt, window: notice.window },
        ]);
        for (const e of evts) insertEvt(messageId, e.type, e, traceId);
      }
      const conversation = conversationId ? getConv(conversationId) : null;
      const { NextResponse } = await import("next/server");
      if (!useStreaming) {
        return NextResponse.json({
          ok: true,
          data: { blocked: true, content: notice.message, message: notice.message, resetAt: notice.resetAt, window: notice.window, conversationId, conversation },
        });
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const enq = (o: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
          if (conversationId) enq({ type: "meta", conversationId });
          enq({ type: "done", conversationId, conversation });
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
    }
  }

  return ctx;
};

// ─── Stage 4: routerStage ────────────────────────────────────────────────────
// 路由器（route.ts 151-166 段）

export type RouterInput = QuotaOutput;
export type RouterOutput = RouterInput & {
  routerResult: Awaited<ReturnType<typeof runRouter>>;
};

export const routerStage: Stage<RouterInput, RouterOutput> = async (ctx) => {
  const { traceId, lastUserContent, messages, existingRuntimeSessionId, conversationId } = ctx;

  // 专员会话（E 刀）：不过路由器——cheap 直答/分层是主管人格的机制，专员回合恒走
  // 完整 agent（角色系统提示 + 角色工具白名单在 Pi Service 按 roleId 装配）。
  if (ctx.sessionRoleId) {
    const routerResult = {
      path: "main" as const,
      decision: { needsRag: false, directAnswer: undefined as string | undefined, intent: "complex_workflow" as const, reasoning: `specialist session (${ctx.sessionRoleId})` },
      latencyMs: 0,
    };
    log.info("router skipped (specialist session)", { traceId, roleId: ctx.sessionRoleId });
    return { ...ctx, routerResult };
  }

  // --- Router ---
  // 路由器关闭时仍先过零成本本地问候直答(matchTrivialMessage),只跳过 LLM 分类调用
  const localTrivial = !isEnabled("ROUTER_ENABLED") && lastUserContent ? matchTrivialMessage(lastUserContent) : null;
  const routerResult = isEnabled("ROUTER_ENABLED") && lastUserContent
    ? await runRouter(lastUserContent, messages, traceId, { runtimeSessionId: existingRuntimeSessionId, conversationId })
    : localTrivial
      ? { path: "cheap" as const, decision: localTrivial, latencyMs: 0 }
      : { path: "main" as const, decision: { needsRag: false, directAnswer: undefined as string | undefined, intent: "complex_workflow" as const, reasoning: isEnabled("ROUTER_ENABLED") ? "empty message" : "router disabled" }, latencyMs: 0 };
  log.info("router", { traceId, path: routerResult.path, intent: routerResult.decision.intent, latencyMs: routerResult.latencyMs });

  const { writeSpan } = await import("@/lib/observability/spans");
  writeSpan({
    traceId, spanType: "router", name: "router",
    startedAt: Date.now() - routerResult.latencyMs,
    durationMs: routerResult.latencyMs,
    inputSummary: lastUserContent.slice(0, 200),
    outputSummary: `${routerResult.path} / ${routerResult.decision.intent}`,
  });

  return { ...ctx, routerResult };
};

// ─── Shared helpers (copied from route.ts) ──────────────────────────────────

function shouldUseStreaming(request: Request): boolean {
  return new URL(request.url).searchParams.get("stream") !== "false";
}

/** 解析客户端 role 参数：空 → undefined；非空原样保留，可用性由 sessionStage / requireUsableRoleId 显式校验（失败不回落主管）。 */
function parseRoleParam(raw: string | undefined | null): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/** 创建会话前的 role 校验：非法直接抛错（parseStage 会映射为 400），禁止写入无效 role_id。 */
function requireUsableRoleId(roleParam: string | undefined): string | null {
  if (!roleParam) return null;
  const issue = specialistRoleUsabilityIssue(roleParam);
  if (issue) throw new Error(issue);
  return roleParam;
}

function generateShortTitle(text: string): string {
  const cleaned = text.split(/\n\n(?:附件|用户随消息附加了)[\s\S]*/)[0].replace(/\n+/g, " ").trim() || "新对话";
  const first = cleaned.split(/[，。？！,.?!；;]/)[0].trim();
  return first.length <= 20 ? first : first.slice(0, 18) + "…";
}

// ─── Request parsing helpers (copied from route.ts) ─────────────────────────
// Needed by parseStage. Kept here to make parseStage self-contained.

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024; // 与前端一致；大批文件走文件夹索引，不塞提示词

async function saveAttachmentBuffer(traceId: string, fileName: string, mimeType: string, buffer: Buffer): Promise<AgentAttachment> {
  if (buffer.length > ATTACHMENT_MAX_BYTES) {
    throw new AttachmentTooLargeError(buffer.length, ATTACHMENT_MAX_BYTES);
  }
  const store = await getFileWorkspaceStore();
  const asset = store.ingestManagedBuffer({
    name: fileName,
    mediaType: mimeType || guessMimeType(fileName),
    content: buffer,
    batchId: traceId,
  });
  const storagePath = store.materializeVersion(asset.versionId, path.join(getRunFileWorkspaceDir(traceId), "inputs"), asset.name);
  return {
    assetId: asset.assetId,
    versionId: asset.versionId,
    name: asset.name,
    mimeType: asset.mediaType,
    size: asset.sizeBytes,
    dataUrl: "",
    storagePath,
  };
}

async function parseMultipartRequest(request: Request, traceId: string) {
  const { createChatConversation: createConv } = await import("@/lib/db/sqlite");
  const formData = await request.formData();
  const messages: AgentMessage[] = formData.get("messages") ? (JSON.parse(formData.get("messages") as string) as AgentMessage[]) : [];
  let conversationId: number | undefined = (formData.get("conversationId") as string) ? Number(formData.get("conversationId")) : undefined;
  const roleParam = parseRoleParam(formData.get("role") as string | null);
  const uploadedFiles = formData.getAll("files") as File[];
  const attachments: AgentAttachment[] = [];

  if (uploadedFiles.length > 0) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!conversationId && lastUser?.content.trim()) {
      conversationId = createConv(generateShortTitle(lastUser.content.trim()), requireUsableRoleId(roleParam));
      log.info("conversation created for files", { traceId, conversationId });
    }
    if (conversationId) {
      for (const file of uploadedFiles) {
        const buffer = Buffer.from(await file.arrayBuffer());
        attachments.push(await saveAttachmentBuffer(traceId, file.name, file.type, buffer));
      }
    }
  }

  const refJson = formData.get("referencedAttachments") as string | null;
  if (refJson) { try { attachments.push(...(JSON.parse(refJson) as AgentAttachment[])); } catch { /* ok */ } }
  const managedJson = formData.get("managedAttachments") as string | null;
  if (managedJson) { try { attachments.push(...(JSON.parse(managedJson) as AgentAttachment[])); } catch { /* ok */ } }

  let referencedSkills: string[] = [];
  const skillsJson = formData.get("referencedSkills") as string | null;
  if (skillsJson) { try { referencedSkills = JSON.parse(skillsJson) as string[]; } catch { /* ok */ } }
  const modelTier = (formData.get("modelTier") as string | null) ?? undefined;
  const workspaceRootIds = parseWorkspaceRootIds(formData.get("workspaceRootIds") as string | null);

  return { messages, conversationId, attachments, referencedSkills, modelTier, roleParam, workspaceRootIds };
}

async function parseJsonRequest(request: Request, traceId: string) {
  const { createChatConversation: createConv } = await import("@/lib/db/sqlite");
  const body = (await request.json()) as { conversationId?: number; messages?: AgentMessage[]; prompt?: string; attachments?: AgentAttachment[]; referencedSkills?: string[]; modelTier?: string; role?: string; workspaceRootIds?: string[] };
  let conversationId = body.conversationId;
  const roleParam = parseRoleParam(body.role);
  const rawAttachments = body.attachments ?? [];

  // Persist any dataUrl-only attachments to disk so downstream providers can
  // always read them via storagePath rather than
  // relying on inline base64 blocks that some gateways silently drop.
  const attachments: AgentAttachment[] = [];
  for (const att of rawAttachments) {
    if (!att.storagePath && att.dataUrl) {
      // Decode base64 payload from the data URL (data:<mime>;base64,<payload>)
      const commaIdx = att.dataUrl.indexOf(",");
      const base64Payload = commaIdx >= 0 ? att.dataUrl.slice(commaIdx + 1) : att.dataUrl;
      const buffer = Buffer.from(base64Payload, "base64");
      if (buffer.length > 0) {
        // Auto-create a conversation when one doesn't exist yet.
        if (!conversationId) {
          const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
          const title = lastUser?.content?.trim() ? generateShortTitle(lastUser.content.trim()) : "新对话";
          conversationId = createConv(title, requireUsableRoleId(roleParam));
        }
        attachments.push(await saveAttachmentBuffer(traceId, att.name, att.mimeType, buffer));
        continue;
      }
    }
    attachments.push(att);
  }

  return { messages: body.messages ?? [{ role: "user" as const, content: body.prompt ?? "" }], conversationId, attachments, referencedSkills: body.referencedSkills ?? [], modelTier: body.modelTier, roleParam, workspaceRootIds: parseWorkspaceRootIds(body.workspaceRootIds) };
}

function logicalAssetPath(assetId: string, name: string): string {
  return `asset/${assetId}/${encodeURIComponent(path.basename(name))}`;
}

function parseWorkspaceRootIds(raw: string | string[] | null | undefined): string[] {
  let values: unknown = raw;
  if (typeof raw === "string") {
    try { values = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)))].slice(0, 20);
}

function guessMimeType(fileName: string): string {
  const map: Record<string, string> = { ".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".pdf":"application/pdf",".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",".xls":"application/vnd.ms-excel",".csv":"text/csv",".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",".doc":"application/msword",".txt":"text/plain",".md":"text/markdown",".json":"application/json",".html":"text/html" };
  return map[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}
