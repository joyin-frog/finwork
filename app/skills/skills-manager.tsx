"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Delete02Icon, MagicWand01Icon, Search01Icon, ArrowRight01Icon, ArrowDown01Icon, FolderFileStorageIcon, FolderOpenIcon, File01Icon, CodeIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildFileTree, filterSkills, fileLang, type FileTreeNode } from "@/app/skills/file-tree";
import { cn } from "@/lib/utils";

/** 小工具按钮:只放图标,说明走 hover(同主菜单搜索/侧栏按钮的范式)。 */
function IconButton({
  icon,
  label,
  onClick,
  active,
  tone = "default",
  size = 16,
}: {
  icon: typeof Add01Icon;
  label: string;
  onClick: () => void;
  active?: boolean;
  tone?: "default" | "destructive";
  size?: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "inline-grid place-items-center size-7 rounded-md transition-colors",
            tone === "destructive"
              ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              : active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={icon} size={size} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** 系统/个人 标签:用色块+文字区分,系统=中性,个人=品牌色描边。 */
function SourceTag({ source }: { source: SkillSource }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-meta",
        source === "user" ? "text-[var(--primary)] bg-[var(--primary)]/8" : "text-muted-foreground bg-muted",
      )}
    >
      {source === "user" ? "个人" : "系统"}
    </span>
  );
}

type SkillSource = "bundled" | "user";
type SkillSummary = { name: string; description: string; source: SkillSource; editable: boolean; enabled: boolean };
type SkillFileEntry = { path: string; isDir: boolean; size: number };

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 渲染预览时去掉开头的 YAML frontmatter(--- … ---),只看正文,避免把 name/description 当正文显示。 */
function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; error?: string; status: number }> {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  return { ok: Boolean(json.ok), data: json.data, error: json.error, status: res.status };
}

export function SkillsManager() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const loadSkills = useCallback(async () => {
    const r = await api<SkillSummary[]>("/api/skills");
    if (r.ok && r.data) setSkills(r.data);
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  async function toggleEnabled(name: string, enabled: boolean) {
    // 乐观更新,失败回滚
    setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
    const r = await api(`/api/skills/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) {
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled: !enabled } : s)));
      toast.error(r.error ?? "切换失败");
    }
  }

  const selectedSkill = skills.find((s) => s.name === selected) ?? null;
  const visibleSkills = filterSkills(skills, query);

  return (
    <div className="h-full flex">
      {/* 左:技能列表 */}
      <aside className="w-72 shrink-0 border-r border-border flex flex-col">
        <div className="flex items-center justify-between px-4 h-12 shrink-0 border-b border-border">
          <h1 className="text-title font-semibold">技能</h1>
          <div className="flex items-center gap-0.5">
            <IconButton icon={Search01Icon} label="搜索" active={searchOpen} onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setQuery(""); }} />
            <IconButton icon={Add01Icon} label="新建技能" onClick={() => { setCreating(true); setSelected(null); }} />
          </div>
        </div>
        {searchOpen && (
          <div className="px-3 py-2 shrink-0 border-b border-border">
            <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索技能…" className="h-8" />
          </div>
        )}
        <ScrollArea className="flex-1">
          <div className="p-2 flex flex-col gap-0.5">
            {visibleSkills.map((s) => (
              <div
                key={s.name}
                role="button"
                tabIndex={0}
                onClick={() => { setSelected(s.name); setCreating(false); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(s.name); setCreating(false); } }}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-2 text-left cursor-pointer transition-colors",
                  selected === s.name ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <HugeiconsIcon icon={MagicWand01Icon} size={16} className="shrink-0 text-muted-foreground" />
                <span className={cn("flex-1 min-w-0 truncate text-body", !s.enabled && "text-muted-foreground line-through")}>
                  {s.name}
                </span>
                <SourceTag source={s.source} />
                <Switch
                  checked={s.enabled}
                  onClick={(e) => e.stopPropagation()}
                  onCheckedChange={(v) => void toggleEnabled(s.name, v)}
                  aria-label={`${s.enabled ? "停用" : "启用"} ${s.name}`}
                />
              </div>
            ))}
            {skills.length === 0 && <p className="px-2 py-4 text-meta text-muted-foreground">加载中…</p>}
            {skills.length > 0 && visibleSkills.length === 0 && <p className="px-2 py-4 text-meta text-muted-foreground">无匹配技能</p>}
          </div>
        </ScrollArea>
      </aside>

      {/* 右:编辑器 / 新建 / 空态 */}
      <main className="flex-1 min-w-0">
        {creating ? (
          <NewSkillForm
            existing={skills.map((s) => s.name)}
            onCancel={() => setCreating(false)}
            onCreated={async (name) => { setCreating(false); await loadSkills(); setSelected(name); }}
          />
        ) : selectedSkill ? (
          <SkillEditor
            key={selectedSkill.name}
            skill={selectedSkill}
            onDeleted={async () => { setSelected(null); await loadSkills(); }}
          />
        ) : (
          <div className="h-full grid place-items-center text-muted-foreground text-body">
            从左侧选择一个技能,或「新建」
          </div>
        )}
      </main>
    </div>
  );
}

// ── 新建技能表单 ─────────────────────────────────────────────────────────

function NewSkillForm({
  existing,
  onCancel,
  onCreated,
}: {
  existing: string[];
  onCancel: () => void;
  onCreated: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("# 技能说明\n\n描述这个技能要做什么、怎么做。");
  const [busy, setBusy] = useState(false);

  const nameErr =
    name && !SKILL_NAME_RE.test(name)
      ? "只能用小写字母、数字、连字符,且字母/数字开头"
      : existing.includes(name)
        ? "该名称已存在"
        : "";

  async function submit() {
    if (!name || nameErr) return;
    setBusy(true);
    const r = await api<{ name: string }>("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description, body }),
    });
    setBusy(false);
    if (r.ok && r.data) {
      toast.success("已创建技能");
      await onCreated(r.data.name);
    } else {
      toast.error(r.error ?? "创建失败");
    }
  }

  return (
    <div className="h-full overflow-auto px-6 py-5 max-w-2xl">
      <h2 className="text-title font-semibold mb-4">新建技能</h2>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-body">技能名(英文标识)</span>
          <Input value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="例如 my-reimburse-check" />
          {nameErr && <span className="text-meta text-destructive">{nameErr}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-body">描述(触发说明,给 AI 判断何时用)</span>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-body">SKILL.md 正文</span>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="font-mono text-small" />
        </label>
        <div className="flex gap-2">
          <Button onClick={() => void submit()} disabled={!name || !!nameErr || busy}>创建</Button>
          <Button variant="ghost" onClick={onCancel}>取消</Button>
        </div>
      </div>
    </div>
  );
}

// ── 技能编辑器(文件树 + 文件编辑 + markdown 源码/渲染) ───────────────────

function SkillEditor({ skill, onDeleted }: { skill: SkillSummary; onDeleted: () => void | Promise<void> }) {
  const [files, setFiles] = useState<SkillFileEntry[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [view, setView] = useState<"source" | "render">("source");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const editable = skill.editable;
  const dirty = content !== savedContent;
  const lang = activeFile ? fileLang(activeFile) : null;
  const isMd = lang === "markdown";
  const isCode = !!lang && !isMd; // 可按代码块高亮渲染的脚本(.py/.js/.json…)
  const canRender = isMd || isCode;
  const tree = useMemo(() => buildFileTree(files), [files]);

  const toggleDir = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** 展开某文件的所有祖先目录,确保它在树里可见(新建深层文件 / 打开深层文件时用)。 */
  const expandAncestors = (rel: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const segs = rel.split("/");
      for (let i = 1; i < segs.length; i++) next.add(segs.slice(0, i).join("/"));
      return next;
    });

  const loadFiles = useCallback(async (open?: string) => {
    const r = await api<SkillFileEntry[]>(`/api/skills/${encodeURIComponent(skill.name)}/files`);
    const list = r.ok && r.data ? r.data : [];
    setFiles(list);
    const first = open ?? list.find((f) => f.path === "SKILL.md")?.path ?? list.find((f) => !f.isDir)?.path ?? null;
    if (first) void openFile(first);
    else { setActiveFile(null); setContent(""); setSavedContent(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.name]);

  const openFile = useCallback(async (rel: string) => {
    const r = await api<{ content: string }>(`/api/skills/${encodeURIComponent(skill.name)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`);
    setActiveFile(rel);
    setContent(r.data?.content ?? "");
    setSavedContent(r.data?.content ?? "");
    // 内置(只读)的可渲染文件默认渲染视图;用户技能默认源码(便于编辑)。
    setView(fileLang(rel) && !editable ? "render" : "source");
  }, [skill.name, editable]);

  useEffect(() => { void loadFiles(); }, [loadFiles]);

  async function saveFile() {
    if (!activeFile) return;
    const r = await api(`/api/skills/${encodeURIComponent(skill.name)}/files/${activeFile.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (r.ok) { setSavedContent(content); toast.success("已保存"); }
    else toast.error(r.error ?? "保存失败");
  }

  async function newFile() {
    const rel = window.prompt("新文件相对路径(如 scripts/run.py):");
    if (!rel) return;
    const r = await api(`/api/skills/${encodeURIComponent(skill.name)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    if (r.ok) { await loadFiles(rel); expandAncestors(rel); toast.success("已新建文件"); }
    else toast.error(r.error ?? "新建失败");
  }

  async function deleteFile(rel: string) {
    if (!window.confirm(`删除文件 ${rel}?`)) return;
    const r = await api(`/api/skills/${encodeURIComponent(skill.name)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
    if (r.ok) { await loadFiles(); toast.success("已删除"); }
    else toast.error(r.error ?? "删除失败");
  }

  async function deleteSkill() {
    if (!window.confirm(`删除技能「${skill.name}」?此操作不可撤销。`)) return;
    const r = await api(`/api/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
    if (r.ok) { toast.success("已删除技能"); await onDeleted(); }
    else toast.error(r.error ?? "删除失败");
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏:技能名 + 来源 + 删除 */}
      <div className="flex items-center gap-2 px-5 h-12 shrink-0 border-b border-border">
        <h2 className="text-title font-semibold">{skill.name}</h2>
        <span className="text-meta text-muted-foreground">{skill.source === "bundled" ? "系统 · 只读" : "个人"}</span>
        <div className="flex-1" />
        {editable && <IconButton icon={Delete02Icon} label="删除技能" tone="destructive" onClick={() => void deleteSkill()} />}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 文件树 */}
        <div className="w-56 shrink-0 border-r border-border flex flex-col">
          <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-border">
            <span className="text-meta text-muted-foreground">文件</span>
            {editable && <IconButton icon={Add01Icon} label="新建文件" size={15} onClick={() => void newFile()} />}
          </div>
          <ScrollArea className="flex-1">
            <div className="p-1.5 flex flex-col gap-0.5">
              <FileTreeView
                nodes={tree}
                depth={0}
                activeFile={activeFile}
                expanded={expanded}
                editable={editable}
                toggleDir={toggleDir}
                openFile={(rel) => void openFile(rel)}
                deleteFile={(rel) => void deleteFile(rel)}
              />
            </div>
          </ScrollArea>
        </div>

        {/* 文件内容 */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-2 px-4 h-9 shrink-0 border-b border-border">
            <span className="text-meta text-muted-foreground truncate">{activeFile ?? "无文件"}</span>
            <div className="flex-1" />
            {canRender && (
              <div className="inline-flex rounded-md border border-border p-0.5 text-meta">
                <button
                  type="button"
                  onClick={() => setView("source")}
                  className={cn("px-2 py-0.5 rounded", view === "source" ? "bg-accent text-foreground" : "text-muted-foreground")}
                >
                  源码
                </button>
                <button
                  type="button"
                  onClick={() => setView("render")}
                  className={cn("px-2 py-0.5 rounded", view === "render" ? "bg-accent text-foreground" : "text-muted-foreground")}
                >
                  渲染
                </button>
              </div>
            )}
            {editable && (
              <Button size="sm" disabled={!dirty} onClick={() => void saveFile()}>保存</Button>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            {!activeFile ? (
              <div className="h-full grid place-items-center text-muted-foreground text-body">空技能,点右上「+」新建文件</div>
            ) : canRender && view === "render" ? (
              <div className="md-content px-6 py-5">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {isMd ? stripFrontmatter(content) : `\`\`\`${lang}\n${content}\n\`\`\``}
                </ReactMarkdown>
              </div>
            ) : (
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                readOnly={!editable}
                spellCheck={false}
                className="h-full w-full resize-none rounded-none border-0 font-mono text-small leading-relaxed focus-visible:ring-0"
              />
            )}
          </div>
          {!editable && (
            <div className="px-4 py-2 shrink-0 border-t border-border text-meta text-muted-foreground">
              系统技能只读。可在左侧列表启停;如需定制,请「新建」一个个人技能。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 递归渲染折叠文件树:目录带左侧箭头、点击展开/收起(默认全部收起);文件可打开/删除。 */
function FileTreeView({
  nodes,
  depth,
  activeFile,
  expanded,
  editable,
  toggleDir,
  openFile,
  deleteFile,
}: {
  nodes: FileTreeNode[];
  depth: number;
  activeFile: string | null;
  expanded: Set<string>;
  editable: boolean;
  toggleDir: (path: string) => void;
  openFile: (rel: string) => void;
  deleteFile: (rel: string) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.isDir ? (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => toggleDir(node.path)}
              className="flex w-full items-center gap-1 rounded-md py-1.5 text-left text-small text-muted-foreground hover:bg-accent/60"
              style={{ paddingLeft: depth * 14 + 8, paddingRight: 8 }}
            >
              <HugeiconsIcon icon={expanded.has(node.path) ? ArrowDown01Icon : ArrowRight01Icon} size={13} className="shrink-0" />
              <HugeiconsIcon icon={expanded.has(node.path) ? FolderOpenIcon : FolderFileStorageIcon} size={15} className="shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            {expanded.has(node.path) && (
              <FileTreeView
                nodes={node.children}
                depth={depth + 1}
                activeFile={activeFile}
                expanded={expanded}
                editable={editable}
                toggleDir={toggleDir}
                openFile={openFile}
                deleteFile={deleteFile}
              />
            )}
          </div>
        ) : (
          <div key={node.path} className={cn("group flex items-center rounded-md", activeFile === node.path && "bg-accent")}>
            <button
              type="button"
              onClick={() => openFile(node.path)}
              className="flex flex-1 min-w-0 items-center gap-1.5 py-1.5 text-left text-small"
              style={{ paddingLeft: depth * 14 + 8, paddingRight: 8 }}
            >
              <HugeiconsIcon
                icon={fileLang(node.name) && fileLang(node.name) !== "markdown" ? CodeIcon : File01Icon}
                size={14}
                className="shrink-0 text-muted-foreground"
              />
              <span className="truncate">{node.name}</span>
            </button>
            {editable && node.path !== "SKILL.md" && (
              <button
                type="button"
                onClick={() => deleteFile(node.path)}
                aria-label={`删除 ${node.path}`}
                className="shrink-0 px-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
              >
                <HugeiconsIcon icon={Delete02Icon} size={13} />
              </button>
            )}
          </div>
        ),
      )}
    </>
  );
}
