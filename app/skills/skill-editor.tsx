"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Delete02Icon, ArrowRight01Icon, ArrowDown01Icon, FolderFileStorageIcon, FolderOpenIcon, File01Icon, CodeIcon, ViewIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildFileTree, fileLang, type FileTreeNode } from "@/app/skills/file-tree";
import { IconButton, api, stripFrontmatter } from "@/app/skills/skills-shared";
import type { SkillSummary, SkillFileEntry } from "@/app/skills/skills-shared";
import { cn } from "@/lib/utils";

export function SkillEditor({ skill }: { skill: SkillSummary }) {
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

  return (
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
          {/* 源码/渲染切换只对 Markdown 有意义(两种视图内容不同);纯代码文件不需要——只读时
              直接整页渲染高亮,可编辑时直接编辑源码,没有"第三种视图"要切换。 */}
          {isMd && (
            <div className="inline-flex gap-0.5">
              <IconButton icon={CodeIcon} label="源码" active={view === "source"} onClick={() => setView("source")} />
              <IconButton icon={ViewIcon} label="渲染" active={view === "render"} onClick={() => setView("render")} />
            </div>
          )}
          {editable && (
            <Button size="sm" disabled={!dirty} onClick={() => void saveFile()}>保存</Button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {!activeFile ? (
            <div className="h-full grid place-items-center text-muted-foreground text-body">空技能,点右上「+」新建文件</div>
          ) : isMd && view === "render" ? (
            <div className="md-content px-6 py-5">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {stripFrontmatter(content)}
              </ReactMarkdown>
            </div>
          ) : isCode && !editable ? (
            // 只读代码文件:整个内容区就是代码本身,不套聊天气泡样式的小卡片(那套限高 240px,
            // 是给对话里的短代码片段用的,不适合当完整文件查看器)。
            <div className="skill-code-view px-6 py-5">
              <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{`\`\`\`${lang}\n${content}\n\`\`\``}</ReactMarkdown>
            </div>
          ) : (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              readOnly={!editable}
              spellCheck={false}
              // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
              className="h-full w-full resize-none rounded-none border-0 font-mono text-small leading-relaxed focus-visible:ring-0"
            />
          )}
        </div>
        {!editable && (
          <div className="px-4 py-2 shrink-0 border-t border-border text-meta text-muted-foreground">
            系统技能内置启用、只读。如需定制,请「新建」一个个人技能。
          </div>
        )}
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
              // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
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
          // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
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
