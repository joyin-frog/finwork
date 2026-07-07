/**
 * artifact-store: WP14a 可勾选清单工件的数据访问层
 *
 * 三个操作：
 *   createArtifact — 生成 uuid、序列化 items、落库、返回 id
 *   getArtifact   — 读取 payload+state，反序列化返回
 *   patchArtifactState — 校验 itemId+state 枚举后原子更新 state，last-write-wins
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ArtifactItemSeverity = "warn" | "info";

export type ArtifactItem = {
  id: string;
  label: string;
  detail?: string;
  severity?: ArtifactItemSeverity;
};

export type ArtifactState = "open" | "done" | "ignored";

export type Artifact = {
  id: string;
  kind: string;
  conversationId: number | null;
  title: string;
  items: ArtifactItem[];
  state: Record<string, ArtifactState>;
  createdAt: string;
  updatedAt: string;
};

const VALID_STATES: ReadonlySet<string> = new Set(["open", "done", "ignored"]);

export function createArtifact(
  db: DatabaseSync,
  opts: {
    title: string;
    items: Array<Omit<ArtifactItem, "id"> & { id?: string }>;
    conversationId: number | null;
  }
): string {
  const id = randomUUID();
  // 分配稳定 id（若调用方未提供则生成）
  const itemsWithId: ArtifactItem[] = opts.items.map((item, i) => ({
    id: item.id ?? `item-${i + 1}-${id.slice(0, 8)}`,
    label: item.label,
    ...(item.detail != null ? { detail: item.detail } : {}),
    ...(item.severity != null ? { severity: item.severity } : {}),
  }));

  const payload = JSON.stringify({ items: itemsWithId });
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");

  db.prepare(`
    INSERT INTO artifacts (id, kind, conversation_id, title, payload, state, created_at, updated_at)
    VALUES (?, 'checklist', ?, ?, ?, '{}', ?, ?)
  `).run(id, opts.conversationId, opts.title, payload, now, now);

  return id;
}

export function getArtifact(db: DatabaseSync, id: string): Artifact | null {
  const row = db.prepare(`
    SELECT id, kind, conversation_id, title, payload, state, created_at, updated_at
    FROM artifacts WHERE id = ?
  `).get(id) as {
    id: string; kind: string; conversation_id: number | null;
    title: string; payload: string; state: string;
    created_at: string; updated_at: string;
  } | undefined;

  if (!row) return null;

  let parsedPayload: { items: ArtifactItem[] } = { items: [] };
  let parsedState: Record<string, ArtifactState> = {};
  try { parsedPayload = JSON.parse(row.payload) as typeof parsedPayload; } catch { /* keep default */ }
  try { parsedState = JSON.parse(row.state) as typeof parsedState; } catch { /* keep default */ }

  return {
    id: row.id,
    kind: row.kind,
    conversationId: row.conversation_id,
    title: row.title,
    items: parsedPayload.items ?? [],
    state: parsedState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 校验 itemId 存在 + state 枚举合法，原子更新 state（last-write-wins）。
 * 校验失败抛出 Error；成功返回 true。
 */
export function patchArtifactState(
  db: DatabaseSync,
  id: string,
  itemId: string,
  state: ArtifactState
): true {
  if (!VALID_STATES.has(state)) {
    throw new Error(`无效的 state 枚举值：${state}。允许值为 open/done/ignored`);
  }

  const artifact = getArtifact(db, id);
  if (!artifact) {
    throw new Error(`artifact ${id} 不存在`);
  }

  const itemExists = artifact.items.some((item) => item.id === itemId);
  if (!itemExists) {
    throw new Error(`itemId "${itemId}" 不在 payload items 中，无法更新`);
  }

  const newState = { ...artifact.state, [itemId]: state };
  const stateJson = JSON.stringify(newState);
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");

  db.prepare(`
    UPDATE artifacts SET state = ?, updated_at = ? WHERE id = ?
  `).run(stateJson, now, id);

  return true;
}
