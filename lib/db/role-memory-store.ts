/**
 * role-memory-store.ts — 每角色独立记忆读写（智能体 IA · C 刀）。
 *
 * 按 role_id 隔离：一个角色的记忆不与其他角色共享（隔离即隐私边界）。
 * 走 getDb() 单例，惯例与 dispatch-store.ts 一致。
 *
 * 第一版：手动增/查/删 + 运行时注入。自动沉淀（从对话侦测口径自动写入）为后续独立一刀。
 */

import { getDb } from "./sqlite";

export type RoleMemoryItem = {
  id: number;
  roleId: string;
  content: string;
  /** 来源标注：手动添加为 NULL；自动沉淀刀填任务/会话来源。 */
  source: string | null;
  createdAt: string;
};

export function listRoleMemory(roleId: string): RoleMemoryItem[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, role_id, content, source, created_at
       FROM role_memory
      WHERE role_id = ?
      ORDER BY created_at DESC, id DESC`
  ).all(roleId) as Array<{ id: number; role_id: string; content: string; source: string | null; created_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    roleId: r.role_id,
    content: r.content,
    source: r.source,
    createdAt: r.created_at,
  }));
}

/** 新增一条记忆，返回新行 id。source 空时落 NULL（手动添加）。 */
export function addRoleMemory(roleId: string, content: string, source?: string | null): number {
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO role_memory (role_id, content, source) VALUES (?, ?, ?)`
  ).run(roleId, content, source ?? null);
  return Number(info.lastInsertRowid);
}

/**
 * 删除一条记忆，返回是否删到行。
 * 必须同时按 role_id 约束：id 是全表自增，只按 id 删会让一个角色删掉另一个角色的记忆
 * （破坏隔离隐私边界）。
 */
export function deleteRoleMemory(id: number, roleId: string): boolean {
  const db = getDb();
  const info = db.prepare(`DELETE FROM role_memory WHERE id = ? AND role_id = ?`).run(id, roleId);
  return info.changes > 0;
}

/**
 * 运行时注入用：取该角色记忆的 content 列表（拼进系统提示）。
 * 倒序取最近 limit 条，避免超长提示。
 */
export function getRoleMemoryForPrompt(roleId: string, limit = 50): string[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT content FROM role_memory
      WHERE role_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ).all(roleId, limit) as Array<{ content: string }>;
  return rows.map((r) => r.content);
}
