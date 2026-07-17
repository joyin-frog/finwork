"use client";

/**
 * 角色工作台 /agents/<roleId> — 智能体 IA 重构。
 *
 * 见 docs/spec/design-agents-ia.md：
 *   - 头部（头像+名称+状态+派任务）+ 四页签（工作/记忆/相关对话/概况）。
 *   - 工作页签 = 任务流水 + 右侧三态预览（见 workspace-work-tab.tsx）。
 *   - 记忆 / 相关对话 / 和它对话 / 启停开关为后续刀。
 */

import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { MessageAdd01Icon, BubbleChatIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { useNavState } from "@/app/shared/nav-state";
import { ROLE_UI, ROLE_LABELS } from "@/lib/domain/role-ui";
import { relativeTime } from "@/lib/utils/relative-time";
import { WorkspaceWorkTab } from "./workspace-work-tab";

type SkillEntry = { name: string; description: string };

type RoleDetail = {
  roleId: string;
  name: string;
  domain: string;
  charter: string;
  dataScope: string[];
  skills: SkillEntry[];
  available: boolean;
  userDisabled: boolean;
  status: string | null;
  blockedReason: string | null;
  conversationId: string | null;
  reviewPending: boolean;
};

type WorkTab = "work" | "memory" | "conversations" | "profile";

const TABS: { key: WorkTab; label: string }[] = [
  { key: "work", label: "工作" },
  { key: "memory", label: "记忆" },
  { key: "conversations", label: "相关对话" },
  { key: "profile", label: "概况" },
];

export default function AgentWorkspacePage() {
  const params = useParams();
  const roleId = typeof params.roleId === "string" ? params.roleId : Array.isArray(params.roleId) ? params.roleId[0] : "";

  const { fetchAgentRoster } = useNavState();
  const [role, setRole] = useState<RoleDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<WorkTab>("work");

  // 请求令牌：切角色时递增，过期响应到达时丢弃——避免快速切角色时旧请求覆盖新角色的数据。
  const requestTokenRef = useRef(0);

  const fetchRole = useCallback(async () => {
    const token = ++requestTokenRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch("/api/agents", { cache: "no-store" });
      const json = await res.json();
      if (token !== requestTokenRef.current) return;
      if (json.ok) {
        setRole((json.data.roster as RoleDetail[]).find((r) => r.roleId === roleId) ?? null);
      } else {
        setLoadError(true);
      }
    } catch {
      if (token !== requestTokenRef.current) return;
      setLoadError(true);
    } finally {
      if (token === requestTokenRef.current) setLoading(false);
    }
  }, [roleId]);

  useEffect(() => { void fetchRole(); }, [fetchRole]);

  const ui = role ? ROLE_UI[role.roleId as keyof typeof ROLE_UI] : undefined;
  const tone = ui?.tone ?? "--tone-neutral";
  const isRunning = role?.status === "running";
  const isBlocked = (role?.blockedReason != null && role.blockedReason !== "") || (role?.reviewPending ?? false);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶栏：拖拽 + 侧栏开关 + 角色身份 + 派任务 */}
      <header className="app-page-header relative flex items-center gap-3 pr-5 h-11 shrink-0">
        <DragHandle />
        <SidebarToggle />
        {role && (
          <>
            <span
              className="fa-toned shrink-0 flex items-center justify-center w-7 h-7 text-small font-semibold select-none"
              style={{ "--tone": `var(${tone})`, borderRadius: "50%" } as CSSProperties}
              aria-hidden="true"
            >
              {role.name.slice(0, 1)}
            </span>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-title font-semibold shrink-0">{role.name}</span>
              {isRunning && (
                <span className="fa-tone-pill text-meta shrink-0" style={{ "--tone": "var(--tone-analysis)" } as CSSProperties}>
                  进行中
                </span>
              )}
              {isBlocked && !isRunning && (
                <span className="fa-tone-pill text-meta shrink-0" style={{ "--tone": "var(--tone-notice)" } as CSSProperties}>
                  待拍板
                </span>
              )}
              <span className="text-meta text-muted-foreground truncate">{role.domain}</span>
            </div>
            <div className="ml-auto shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href={`/chat/new?prompt=${encodeURIComponent(`请${role.name}，`)}`} aria-label="派任务">
                    <Button size="icon">
                      <HugeiconsIcon icon={MessageAdd01Icon} size={16} />
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent>派任务</TooltipContent>
              </Tooltip>
            </div>
          </>
        )}
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-body text-muted-foreground">加载中…</div>
      ) : loadError ? (
        <div className="flex flex-col items-center gap-3 py-16 text-body text-muted-foreground">
          <p>加载失败</p>
          <Button variant="outline" size="sm" onClick={fetchRole}>重试</Button>
        </div>
      ) : !role ? (
        <div className="flex flex-col items-center gap-3 py-16 text-body text-muted-foreground">
          <p>找不到这个角色</p>
          <Link href="/cockpit"><Button variant="outline" size="sm">回总览</Button></Link>
        </div>
      ) : (
        <>
          {/* 页签 */}
          <div className="flex items-center gap-1 px-page border-b border-border shrink-0">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={
                  "text-body px-3 py-2 border-b-2 -mb-px transition-colors " +
                  (tab === t.key
                    ? "border-primary text-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground")
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 工作页签自管布局（含右侧预览面板，需填满高度）；其余页签走普通滚动容器 */}
          {tab === "work" ? (
            <WorkspaceWorkTab roleId={role.roleId} />
          ) : (
            <div className="flex-1 overflow-auto p-page">
              {tab === "memory" && <MemoryTabView roleId={role.roleId} roleName={role.name} />}
              {tab === "conversations" && <ConversationsTabView roleId={role.roleId} />}
              {tab === "profile" && (
                <ProfileTabView key={role.roleId} role={role} onToggled={fetchAgentRoster} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProfileTabView({ role, onToggled }: { role: RoleDetail; onToggled: () => void }) {
  const [toggling, setToggling] = useState(false);
  // 乐观本地态：点开关即时翻转（/api/agents GET 可能被缓存，refetch 不保证即时反映）。
  const [disabledOverride, setDisabledOverride] = useState<boolean | null>(null);
  const currentDisabled = disabledOverride ?? role.userDisabled;
  const enabled = role.available && !currentDisabled;
  // available:false = 角色本身未开放（非用户可控），开关只管 userDisabled。
  const canToggle = role.available;

  async function handleToggle() {
    if (toggling) return;
    const next = !currentDisabled;
    setToggling(true);
    setDisabledOverride(next); // 乐观
    try {
      const res = await fetch("/api/agents/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleId: role.roleId, disabled: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onToggled(); // 刷新侧栏（置灰/恢复）
    } catch {
      setDisabledOverride(!next); // 回滚
      toast.error("切换失败，请检查网络后重试");
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <section>
        <p className="text-meta font-semibold text-muted-foreground mb-1.5">职责</p>
        <p className="text-body">{role.charter}</p>
      </section>
      <section>
        <p className="text-meta font-semibold text-muted-foreground mb-1.5">数据权限</p>
        <div className="flex flex-wrap gap-1.5">
          {role.dataScope.map((scope) => (
            <Surface key={scope} level="page" edge="hairline" shape="pill" className="text-meta px-2 py-0.5 bg-muted/50">
              {scope}
            </Surface>
          ))}
        </div>
      </section>
      {role.skills.length > 0 && (
        <section>
          <p className="text-meta font-semibold text-muted-foreground mb-1.5">会做的活</p>
          <div className="flex flex-wrap gap-1.5">
            {role.skills.map((skill) => (
              <Surface
                key={skill.name}
                level="page"
                edge="hairline"
                shape="pill"
                className="text-meta px-2 py-0.5 bg-muted/50 cursor-help"
                title={skill.description}
              >
                {skill.name}
              </Surface>
            ))}
          </div>
        </section>
      )}
      <section className="border-t border-border pt-4">
        <p className="text-meta font-semibold text-muted-foreground mb-1.5">启用状态</p>
        <div className="flex items-center gap-3">
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={toggling || !canToggle}
            aria-label={enabled ? "停用该专员" : "启用该专员"}
          />
          <span className="text-body">
            {enabled ? "已启用" : "已停用"}
            <span className="text-meta text-muted-foreground ml-2">
              {!canToggle
                ? "该角色暂未开放"
                : enabled
                  ? "接受派发。停用后不再接受派发、侧栏置灰"
                  : "不接受派发。开启后可再次派活"}
            </span>
          </span>
        </div>
      </section>
    </div>
  );
}

type MemoryItem = { id: number; content: string; source: string | null; createdAt: string };

function MemoryTabView({ roleId, roleName }: { roleId: string; roleName: string }) {
  const [rows, setRows] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchRows = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(roleId)}/memory`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok) setRows(json.data.rows);
      else { setError(true); setRows([]); }
    } catch {
      setError(true); setRows([]);
    }
  }, [roleId]);

  useEffect(() => { void fetchRows(); }, [fetchRows]);

  async function handleAdd() {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(roleId)}/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || String(res.status));
      }
      setDraft("");
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error && e.message && !/^\d+$/.test(e.message) ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    const prev = rows;
    setRows((r) => r?.filter((m) => m.id !== id) ?? r); // 乐观删除
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(roleId)}/memory?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setRows(prev ?? null); // 回滚
      toast.error("删除失败，请检查网络后重试");
    }
  }

  return (
    <div className="max-w-2xl flex flex-col gap-3">
      <div
        className="fa-toned rounded-[var(--radius)] px-3 py-2 text-meta"
        style={{ "--tone": "var(--tone-analysis)" } as CSSProperties}
      >
        独立记忆 · 仅「{roleName}」可见，不与其他角色共享。派活时会作为该角色的口径注入。
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleAdd(); }}
          placeholder="记一条口径，例如：社保基数按杭州 2026 年度标准执行"
          aria-label="新增记忆"
        />
        <Button size="sm" onClick={handleAdd} disabled={saving || !draft.trim()}>添加</Button>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 py-8 text-body text-muted-foreground">
          <p>加载失败</p>
          <Button variant="outline" size="sm" onClick={fetchRows}>重试</Button>
        </div>
      ) : rows == null ? (
        <div className="py-8 text-center text-body text-muted-foreground">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-meta text-muted-foreground">还没有记忆。在上方记下这个角色要遵守的口径与约定</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((m) => (
            <Surface
              key={m.id}
              level="page"
              edge="hairline"
              shape="control"
              className="group flex items-start gap-2 px-3 py-2"
            >
              <span className="flex-1 min-w-0">
                <span className="text-body">{m.content}</span>
                <span className="block text-meta text-muted-foreground mt-0.5">
                  {m.source ?? "手动添加"} · {relativeTime(m.createdAt)}
                </span>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleDelete(m.id)}
                    aria-label="删除这条记忆"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={15} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>删除</TooltipContent>
              </Tooltip>
            </Surface>
          ))}
        </div>
      )}

      <p className="text-meta text-muted-foreground">
        目前需手动记录；从对话里自动沉淀口径为紧接着的能力。
      </p>
    </div>
  );
}

type RoleConversation = { conversationId: number; title: string; updatedAt: string; roleIds: string[] };

function ConversationsTabView({ roleId }: { roleId: string }) {
  const [rows, setRows] = useState<RoleConversation[] | null>(null);
  const [error, setError] = useState(false);

  const fetchRows = useCallback(async () => {
    setError(false);
    setRows(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(roleId)}/conversations`);
      const json = await res.json();
      if (json.ok) setRows(json.data.rows);
      else { setError(true); setRows([]); }
    } catch {
      setError(true); setRows([]);
    }
  }, [roleId]);

  useEffect(() => { void fetchRows(); }, [fetchRows]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-body text-muted-foreground">
        <p>加载失败</p>
        <Button variant="outline" size="sm" onClick={fetchRows}>重试</Button>
      </div>
    );
  }
  if (rows == null) return <div className="py-12 text-center text-body text-muted-foreground">加载中…</div>;
  if (rows.length === 0) {
    return <div className="py-12 text-center text-body text-muted-foreground">还没有相关对话。点右上角「派任务」发起</div>;
  }

  return (
    <div className="max-w-2xl flex flex-col gap-1">
      <p className="text-meta text-muted-foreground mb-2">按角色过滤的全局会话——它们同时也在侧栏「最近」里，这里不是独立的聊天窗。</p>
      {rows.map((c) => {
        const others = c.roleIds.filter((r) => r !== roleId);
        const tag = others.length > 0
          ? `涉及 ${c.roleIds.map((r) => ROLE_LABELS[r] ?? r).join("、")}`
          : "仅本角色";
        return (
          <Link
            key={c.conversationId}
            href={`/chat/recent?id=${c.conversationId}`}
            className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] hover:bg-accent/40 transition-colors"
          >
            <HugeiconsIcon icon={BubbleChatIcon} size={15} className="shrink-0 text-muted-foreground" />
            <span className="flex-1 min-w-0 truncate text-body">{c.title}</span>
            <span className="shrink-0 text-meta text-muted-foreground">{tag}</span>
            <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{relativeTime(c.updatedAt)}</span>
          </Link>
        );
      })}
    </div>
  );
}
