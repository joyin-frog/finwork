import { promises as fs } from "node:fs";
import path from "node:path";
import { getBundledPluginRoot, getUserPluginRoot, getSkillsStatePath } from "@/lib/runtime/paths";

/**
 * 技能数据层:把 SDK 原生 plugin(SKILL.md 文件)暴露成可管理的列表。
 *
 * 模型(用户拍板):
 * - 内置技能 = agent-skills/(只读,随 app 分发):可看、可启停,**不可编辑/删除/改文件**。
 * - 用户技能 = <AppDataDir>/user-skills/(可写):新建、编辑描述/正文、编辑目录下任意文件、删除。
 * - 名字内置/用户互斥(新建时与内置或已有用户技能重名则拒绝),不存在"覆盖内置"。
 * - 启停 = skills-state.json 里的 disabled 名单(SDK context filter,不删文件)。
 */

export type SkillSource = "bundled" | "user";

export type SkillSummary = {
  /** 机器名(= SKILL.md frontmatter 的 name / 目录名),全局唯一,作为主键 */
  name: string;
  description: string;
  source: SkillSource;
  /** 是否可编辑(= 用户技能);内置技能为 false */
  editable: boolean;
  /** 是否启用(未在 disabled 名单里) */
  enabled: boolean;
};

export type SkillDetail = SkillSummary & { body: string };

export type SkillWriteInput = {
  description: string;
  body: string;
};

/** 技能目录下的一个文件/子目录(相对技能根的 POSIX 路径)。 */
export type SkillFileEntry = {
  path: string;
  isDir: boolean;
  size: number;
};

const BUNDLED_PLUGIN_NAME = "finance-skills";
const USER_PLUGIN_NAME = "user-skills";

/** 技能名:单段安全 slug(防路径穿越),小写字母数字与连字符。 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

export class SkillError extends Error {
  constructor(
    message: string,
    readonly code: "exists" | "not_found" | "invalid_name" | "read_only" | "invalid_path",
  ) {
    super(message);
    this.name = "SkillError";
  }
}

// ── frontmatter 解析/序列化 ────────────────────────────────────────────

type ParsedSkill = { name: string; description: string; body: string };

/** 解析 SKILL.md:取首个 `---...---` 块里的 name/description,其余为正文。description 仅按首个冒号
 *  切分,容忍内容里的中文冒号;支持双引号 YAML 标量(我们写回时用)。 */
function parseSkillMd(raw: string): ParsedSkill {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { name: "", description: "", body: raw };
  const fm = m[1];
  const body = m[2] ?? "";
  let name = "";
  let description = "";
  for (const line of fm.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === "name") name = decodeScalar(val);
    else if (key === "description") description = decodeScalar(val);
  }
  return { name, description, body };
}

function decodeScalar(val: string): string {
  if (val.startsWith('"')) {
    try {
      return JSON.parse(val) as string;
    } catch {
      /* 落回原值 */
    }
  }
  if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
    return val.slice(1, -1).replace(/''/g, "'");
  }
  return val;
}

/** description 一律用 JSON 双引号标量写回:含中文冒号/井号/换行也是合法 YAML,避免破坏 frontmatter。 */
function serializeSkillMd(name: string, description: string, body: string): string {
  const trimmedBody = body.replace(/^\s*\n/, "").replace(/\s+$/, "");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${trimmedBody}\n`;
}

// ── 启停状态 ───────────────────────────────────────────────────────────

type SkillsState = { disabled: string[] };

async function readState(): Promise<SkillsState> {
  try {
    const raw = await fs.readFile(getSkillsStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as { disabled?: unknown };
    const disabled = Array.isArray(parsed.disabled)
      ? parsed.disabled.filter((x): x is string => typeof x === "string")
      : [];
    return { disabled };
  } catch {
    return { disabled: [] };
  }
}

async function writeState(state: SkillsState): Promise<void> {
  const p = getSkillsStatePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify({ disabled: [...new Set(state.disabled)].sort() }, null, 2)}\n`, "utf-8");
}

// ── 目录扫描 ───────────────────────────────────────────────────────────

type ScannedSkill = ParsedSkill & { dir: string };

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 扫描一个 plugin 根的 skills/ 目录,返回 name → 技能。读不到/无 SKILL.md 的目录跳过。 */
async function scanRoot(root: string): Promise<Map<string, ScannedSkill>> {
  const out = new Map<string, ScannedSkill>();
  const skillsDir = path.join(root, "skills");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsDir, entry.name);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseSkillMd(raw);
    const name = parsed.name || entry.name;
    if (!isValidSkillName(name)) continue;
    out.set(name, { ...parsed, name, dir });
  }
  return out;
}

async function scanAll(): Promise<{
  bundled: Map<string, ScannedSkill>;
  user: Map<string, ScannedSkill>;
  state: SkillsState;
}> {
  const [bundled, user, state] = await Promise.all([
    scanRoot(getBundledPluginRoot()),
    scanRoot(getUserPluginRoot()),
    readState(),
  ]);
  return { bundled, user, state };
}

// ── 读 ─────────────────────────────────────────────────────────────────

function toSummary(s: ScannedSkill, source: SkillSource, enabled: boolean): SkillSummary {
  return { name: s.name, description: s.description, source, editable: source === "user", enabled };
}

export async function listSkills(): Promise<SkillSummary[]> {
  const { bundled, user, state } = await scanAll();
  const disabled = new Set(state.disabled);
  const list: SkillSummary[] = [];
  for (const [name, s] of bundled) {
    if (user.has(name)) continue; // 互斥;理论上不会发生,用户版优先
    list.push(toSummary(s, "bundled", !disabled.has(name)));
  }
  for (const [name, s] of user) {
    list.push(toSummary(s, "user", !disabled.has(name)));
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

export async function getSkill(name: string): Promise<SkillDetail | null> {
  if (!isValidSkillName(name)) return null;
  const { bundled, user, state } = await scanAll();
  const u = user.get(name);
  const b = bundled.get(name);
  const eff = u ?? b;
  if (!eff) return null;
  const source: SkillSource = u ? "user" : "bundled";
  return { ...toSummary(eff, source, !state.disabled.includes(name)), body: eff.body };
}

// ── 写 ─────────────────────────────────────────────────────────────────

/** 确保用户 plugin 骨架(.claude-plugin/plugin.json + skills/)存在。 */
async function ensureUserPlugin(): Promise<string> {
  const root = getUserPluginRoot();
  const manifest = path.join(root, ".claude-plugin", "plugin.json");
  if (!(await pathExists(manifest))) {
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(
      manifest,
      `${JSON.stringify({ name: USER_PLUGIN_NAME, version: "0.1.0", description: "用户自定义技能" }, null, 2)}\n`,
      "utf-8",
    );
  }
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  return root;
}

/** 校验某技能可被用户编辑:内置→read_only,不存在→not_found,用户技能→放行。 */
async function assertUserEditable(name: string): Promise<void> {
  if (!isValidSkillName(name)) throw new SkillError(`技能名不合法:${name}`, "invalid_name");
  const { bundled, user } = await scanAll();
  if (user.has(name)) return;
  if (bundled.has(name)) throw new SkillError(`内置技能不可编辑:${name}`, "read_only");
  throw new SkillError(`技能不存在:${name}`, "not_found");
}

export async function createSkill(name: string, input: SkillWriteInput): Promise<SkillDetail> {
  if (!isValidSkillName(name)) throw new SkillError(`技能名不合法:${name}`, "invalid_name");
  const { bundled, user } = await scanAll();
  if (bundled.has(name) || user.has(name)) throw new SkillError(`技能已存在:${name}`, "exists");
  const root = await ensureUserPlugin();
  const dir = path.join(root, "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), serializeSkillMd(name, input.description, input.body), "utf-8");
  const detail = await getSkill(name);
  if (!detail) throw new SkillError(`技能写入后读取失败:${name}`, "not_found");
  return detail;
}

export async function updateSkill(name: string, input: SkillWriteInput): Promise<SkillDetail> {
  await assertUserEditable(name);
  const dir = path.join(getUserPluginRoot(), "skills", name);
  await fs.writeFile(path.join(dir, "SKILL.md"), serializeSkillMd(name, input.description, input.body), "utf-8");
  const detail = await getSkill(name);
  if (!detail) throw new SkillError(`技能写入后读取失败:${name}`, "not_found");
  return detail;
}

export async function deleteSkill(name: string): Promise<void> {
  await assertUserEditable(name);
  await fs.rm(path.join(getUserPluginRoot(), "skills", name), { recursive: true, force: true });
}

/** 启用/停用技能(写 disabled 名单);停用是 SDK context filter,不动文件。 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  if (!isValidSkillName(name)) throw new SkillError(`技能名不合法:${name}`, "invalid_name");
  const state = await readState();
  const set = new Set(state.disabled);
  if (enabled) set.delete(name);
  else set.add(name);
  await writeState({ disabled: [...set] });
}

// ── 文件操作 ───────────────────────────────────────────────────────────

/** 解析技能内文件的绝对路径并做穿越防护。forWrite=true 时内置技能拒绝(read_only)。 */
async function resolveSkillFile(name: string, relPath: string, forWrite: boolean): Promise<string> {
  if (!isValidSkillName(name)) throw new SkillError(`技能名不合法:${name}`, "invalid_name");
  const { bundled, user } = await scanAll();
  const isUser = user.has(name);
  const isBundled = bundled.has(name);
  if (!isUser && !isBundled) throw new SkillError(`技能不存在:${name}`, "not_found");
  if (forWrite && !isUser) throw new SkillError(`内置技能不可编辑:${name}`, "read_only");
  const root = isUser ? getUserPluginRoot() : getBundledPluginRoot();
  const base = path.join(root, "skills", name);
  const resolved = path.resolve(base, relPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new SkillError(`非法文件路径:${relPath}`, "invalid_path");
  }
  return resolved;
}

/** 列技能目录下所有文件(递归,相对技能根的 POSIX 路径)。读操作,内置/用户都可用。 */
export async function listSkillFiles(name: string): Promise<SkillFileEntry[]> {
  const base = await resolveSkillFile(name, ".", false);
  const out: SkillFileEntry[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push({ path: childRel, isDir: true, size: 0 });
        await walk(childAbs, childRel);
      } else {
        const st = await fs.stat(childAbs);
        out.push({ path: childRel, isDir: false, size: st.size });
      }
    }
  }
  await walk(base, "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function readSkillFile(name: string, relPath: string): Promise<{ path: string; content: string }> {
  const abs = await resolveSkillFile(name, relPath, false);
  const content = await fs.readFile(abs, "utf-8");
  return { path: relPath, content };
}

export async function writeSkillFile(name: string, relPath: string, content: string): Promise<void> {
  const abs = await resolveSkillFile(name, relPath, true);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

export async function deleteSkillFile(name: string, relPath: string): Promise<void> {
  if (relPath === "SKILL.md") throw new SkillError("SKILL.md 不可删除", "invalid_path");
  const abs = await resolveSkillFile(name, relPath, true);
  await fs.rm(abs, { recursive: true, force: true });
}

// ── 喂给 SDK 的加载配置 ─────────────────────────────────────────────────

export type SkillSdkConfig = {
  plugins: { type: "local"; path: string }[];
  skills: string[] | "all";
};

/**
 * 计算喂给 SDK query 的 { plugins, skills }。
 * - 干净态(无用户技能、无停用)→ 快路径 plugins=[内置], skills='all'(行为同改造前)。
 * - 否则:注册内置+用户两个 plugin,用 plugin 限定名白名单精确指定启用的技能(剔除停用)。
 *   名字内置/用户互斥,无需去重。
 */
export async function getSkillSdkConfig(): Promise<SkillSdkConfig> {
  const { bundled, user, state } = await scanAll();
  const disabled = new Set(state.disabled);
  const bundledRoot = getBundledPluginRoot();

  if (user.size === 0 && disabled.size === 0) {
    return { plugins: [{ type: "local", path: bundledRoot }], skills: "all" };
  }

  const skills: string[] = [];
  for (const name of bundled.keys()) {
    if (!user.has(name) && !disabled.has(name)) skills.push(`${BUNDLED_PLUGIN_NAME}:${name}`);
  }
  for (const name of user.keys()) {
    if (!disabled.has(name)) skills.push(`${USER_PLUGIN_NAME}:${name}`);
  }

  const plugins: { type: "local"; path: string }[] = [{ type: "local", path: bundledRoot }];
  if (user.size > 0) plugins.push({ type: "local", path: getUserPluginRoot() });
  return { plugins, skills };
}
