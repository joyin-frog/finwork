// 附件路径护栏:客户端提交的 referencedAttachments / JSON attachments 里的 storagePath 完全可控,
// 会被原样拼进 agent 系统提示("用户上传了以下文件…路径: …"),而 Read/read_document 是 safe 级、无确认门。
// 不校验的话,构造一个 storagePath:"/Users/x/.ssh/id_rsa" 就能让 agent 读任意文件并返回内容(配合 localhost
// 无 CSRF 校验可被外部网页触发)。这里把每个路径解析进合法根目录,逃逸的一律丢弃。

import path from "node:path";
import { getConversationFilesDir } from "@/lib/runtime/paths";

/** resolved 是否落在 root 之内(含 root 本身)。用与文件下载路由一致的 resolve + 前缀判定。 */
function isInside(root: string, resolved: string): boolean {
  const normRoot = path.resolve(root);
  return resolved === normRoot || resolved.startsWith(normRoot + path.sep);
}

/**
 * 把一个 storagePath 解析成本会话目录内的**绝对路径**;越权 / 逃逸 / 无法锚定会话返回 null。
 * 合法两形:会话目录下的绝对路径(新上传)、会话目录相对路径(引用,如 upload/x、generate/x)。
 * 附件只承载会话文件（知识库统一走 search_knowledge，不经此路径），故根目录只认会话目录 —— fail-closed。
 * conversationId 缺失(新会话首条消息还没建会话)时无法锚定会话目录 → null(拒绝带 storagePath 的附件)。
 */
export function resolveInScopeAttachmentPath(
  storagePath: string,
  conversationId: number | string | undefined
): string | null {
  if (!storagePath || typeof storagePath !== "string") return null;
  if (conversationId == null || String(conversationId).length === 0) return null;
  const root = getConversationFilesDir(conversationId);
  // 相对路径按会话目录解析;绝对路径 path.resolve 原样返回(后由前缀判定拦在根外)。
  const resolved = path.resolve(root, storagePath);
  return isInside(root, resolved) ? resolved : null;
}

/** 判定一个 storagePath 是否指向本会话允许 agent 访问的文件。 */
export function isAllowedAttachmentPath(storagePath: string, conversationId: number | string | undefined): boolean {
  return resolveInScopeAttachmentPath(storagePath, conversationId) !== null;
}

/**
 * 丢弃 storagePath 逃逸出会话目录的附件;无 storagePath 的(纯 dataUrl 远程/内联)原样保留。
 * **关键**:保留的附件把 storagePath 规范化成会话目录内的绝对路径 —— 下游 prompt 里给 agent 的是绝对路径,
 * 否则裸相对串(如 ".env")会被 agent(cwd=项目根)从项目根解析、读到会话目录外的文件。
 */
export function sanitizeAttachments<T extends { storagePath?: string }>(
  attachments: T[],
  conversationId: number | string | undefined,
  additionalRoots: string[] = [],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const a of attachments) {
    if (!a.storagePath) {
      kept.push(a);
      continue;
    }
    const conversationPath = resolveInScopeAttachmentPath(a.storagePath, conversationId);
    const candidate = path.resolve(a.storagePath);
    const additionalPath = additionalRoots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep);
    }) ? candidate : null;
    const resolved = conversationPath ?? additionalPath;
    if (resolved) kept.push({ ...a, storagePath: resolved });
    else dropped.push(a);
  }
  return { kept, dropped };
}
