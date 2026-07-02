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
 * 判定一个 storagePath 是否指向本会话允许 agent 访问的文件。
 * 合法两形:会话目录下的绝对路径(新上传)、会话目录相对路径(引用,如 upload/x、generate/x)。
 * 绝对越权路径 / ../ 逃逸一律不允许。附件只承载会话文件(知识库走 search_knowledge/read_file
 * 工具,不经此路径),故根目录只认会话目录 —— fail-closed。
 * conversationId 缺失(新会话首条消息还没建会话)时无法锚定会话目录 → 一律拒绝带 storagePath 的附件。
 */
export function isAllowedAttachmentPath(storagePath: string, conversationId: number | string | undefined): boolean {
  if (!storagePath || typeof storagePath !== "string") return false;
  if (conversationId == null || String(conversationId).length === 0) return false;
  const root = getConversationFilesDir(conversationId);
  // 相对路径按会话目录解析;绝对路径 path.resolve 原样返回(后由前缀判定拦在根外)。
  return isInside(root, path.resolve(root, storagePath));
}

/** 丢弃 storagePath 逃逸出合法根目录的附件;无 storagePath 的(纯 dataUrl 远程/内联)原样保留。 */
export function sanitizeAttachments<T extends { storagePath?: string }>(
  attachments: T[],
  conversationId: number | string | undefined
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const a of attachments) {
    if (!a.storagePath || isAllowedAttachmentPath(a.storagePath, conversationId)) kept.push(a);
    else dropped.push(a);
  }
  return { kept, dropped };
}
