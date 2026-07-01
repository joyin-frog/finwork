import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const appDirectoryName = "finance-agent";

export function getProjectRoot() {
  return process.env.FINANCE_AGENT_PROJECT_ROOT ?? process.cwd();
}

export function getAppDataDir() {
  return (
    process.env.FINANCE_AGENT_APP_DATA_DIR ??
    process.env.FINANCE_AGENT_DATA_DIR ??
    path.join(getDefaultAppDataRoot(), appDirectoryName)
  );
}

export function getDatabasePath() {
  return process.env.FINANCE_AGENT_DB_PATH ?? path.join(getAppDataDir(), "finance-agent.db");
}

export function getSettingsPath() {
  return process.env.FINANCE_AGENT_SETTINGS_PATH ?? path.join(getAppDataDir(), "local-settings.json");
}

/** API Key 的回落/DPAPI 密文落点(macOS 走钥匙串、不用此文件);见 lib/settings/secret-store.ts。 */
export function getSecretFallbackPath() {
  return process.env.FINANCE_AGENT_SECRET_FILE ?? path.join(getAppDataDir(), "local-secret");
}

/** SDK 原生 skill 的本地 plugin 目录(含 .claude-plugin/plugin.json + skills/);随 app 资源分发,只读。 */
export function getBundledPluginRoot() {
  return process.env.FINANCE_AGENT_BUNDLED_PLUGIN_DIR ?? path.join(getProjectRoot(), "agent-skills");
}

/** 用户可写的 skill plugin 目录:新建/编辑(覆盖内置)的技能落在这里。打包态内置目录只读,故编辑写此处。
 *  与 memory.md / system-prompt.md 同思路放应用数据目录,改完下条消息即生效、无需重编译。 */
export function getUserPluginRoot() {
  return process.env.FINANCE_AGENT_USER_PLUGIN_DIR ?? path.join(getAppDataDir(), "user-skills");
}

/** 技能启停状态(按技能 name 记 disabled 列表);与设置同级落应用数据目录。 */
export function getSkillsStatePath() {
  return process.env.FINANCE_AGENT_SKILLS_STATE_PATH ?? path.join(getAppDataDir(), "skills-state.json");
}

export function getConversationFilesDir(conversationId: number | string) {
  return process.env.FINANCE_AGENT_FILES_DIR
    ?? path.join(getAppDataDir(), "files", String(conversationId));
}

/** 内嵌 Python 运行时目录(打包态由 prepare-tauri 填充);相对项目根,便于在 Tauri 资源目录解析。 */
export function getBundledPythonDir() {
  return process.env.FINANCE_AGENT_PYTHON_RUNTIME_DIR ?? path.join(getProjectRoot(), "workers", "python-runtime");
}

/** 按需安装的 Python 运行时目录(装进 app 自有数据目录,免管理员);见 python-installer.ts。 */
export function getInstalledPythonDir() {
  return path.join(getAppDataDir(), "python-runtime");
}

/** 随安装包内嵌的 Python 归档(C 方案:打包带 tar,首启解压、免 GitHub 下载)。
 *  生产态 = next-server/workers/python-runtime.tar.gz(prepare-tauri 拷 workers/ 时带上,CI release 填充)。 */
export function getBundledPythonArchive() {
  return process.env.FINANCE_AGENT_PYTHON_ARCHIVE ?? path.join(getProjectRoot(), "workers", "python-runtime.tar.gz");
}

/**
 * python-build-standalone(内嵌/按需安装运行时)的解释器路径。
 * 注意 Windows 与 venv 不同:standalone 把 python.exe 放在**根目录**(dir/python.exe),
 * Scripts/ 只在 pip 装了控制台脚本后才有、且不含 python.exe。早期误用 Scripts/python.exe
 * 导致 Windows 上"解压后找不到 Python"安装失败、以及 run_python 找不到解释器。
 */
function standalonePythonExe(dir: string) {
  return process.platform === "win32"
    ? path.join(dir, "python.exe")
    : path.join(dir, "bin", "python3");
}

/** 开发态 venv 的解释器路径(virtualenv 布局:Windows 在 Scripts/ 下)。 */
function venvPythonExe(dir: string) {
  return process.platform === "win32"
    ? path.join(dir, "Scripts", "python.exe")
    : path.join(dir, "bin", "python3");
}

export function getPythonPath() {
  if (process.env.FINANCE_AGENT_PYTHON_PATH) return process.env.FINANCE_AGENT_PYTHON_PATH;
  // 1) 打包内嵌运行时(生产态:用户机器无需自带 Python)
  const bundled = standalonePythonExe(getBundledPythonDir());
  if (fs.existsSync(bundled)) return bundled;
  // 2) 按需安装到 app 数据目录的运行时
  const installed = standalonePythonExe(getInstalledPythonDir());
  if (fs.existsSync(installed)) return installed;
  // 3) 开发态回落到本地 venv
  return venvPythonExe(path.join(getProjectRoot(), "workers", ".venv"));
}

/** Python 解释器所在目录(= getPythonPath 的 dirname)。前置到子进程 PATH,可让 skill 经 Bash
 *  跑的 `python`/`markitdown` 命中与 run_python 同一解释器+依赖(否则 Bash 用 PATH 上的系统 python)。 */
export function getPythonBinDir() {
  return path.dirname(getPythonPath());
}

/** 解释器若位于真实 venv(同级或上级有 pyvenv.cfg)返回 venv 根,用于设 VIRTUAL_ENV;
 *  打包/standalone 运行时不是 venv,返回 null。 */
export function getPythonVenvRoot(): string | null {
  const bin = getPythonBinDir();
  for (const root of [path.dirname(bin), bin]) {
    if (fs.existsSync(path.join(root, "pyvenv.cfg"))) return root;
  }
  return null;
}

export function getDemoDataPath() {
  return process.env.FINANCE_AGENT_DEMO_DATA_PATH ?? path.join(getAppDataDir(), "demo_reimbursements.csv");
}

export function getKnowledgeTextDir() {
  return process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR ?? path.join(getAppDataDir(), "knowledge-text");
}

export function getMemoryPath() {
  return process.env.FINANCE_AGENT_MEMORY_PATH ?? path.join(getAppDataDir(), "memory.md");
}

export function getProfilePath() {
  return process.env.FINANCE_AGENT_PROFILE_PATH ?? path.join(getAppDataDir(), "profile.json");
}

/** 主 Agent 系统提示「静态前缀(A 段)」的用户可编辑覆盖文件;存在即优先于仓库默认与内置常量。
 *  跟 memory.md 一样放应用数据目录,打包后也能改、改完下条消息即生效(无需重新编译)。 */
export function getSystemPromptPath() {
  return process.env.FINANCE_AGENT_SYSTEM_PROMPT_PATH ?? path.join(getAppDataDir(), "system-prompt.md");
}

/** 仓库内的默认模板(随版本管理,开发期可直接改);打包态若未随资源分发则回落内置常量。 */
export function getBundledSystemPromptPath() {
  return process.env.FINANCE_AGENT_BUNDLED_SYSTEM_PROMPT ?? path.join(getProjectRoot(), "lib", "agent", "SYSTEM_PROMPT.md");
}

export function getConventionsPath() {
  return process.env.FINANCE_AGENT_CONVENTIONS_PATH ?? path.join(getAppDataDir(), "conventions.json");
}

/**
 * @anthropic-ai/claude-agent-sdk 的原生 CLI 二进制(claude / claude.exe)。
 * SDK 默认从按平台的 optionalDependencies 包(claude-agent-sdk-<plat>-<arch>)解析该二进制,但 Next
 * standalone 打包不会 trace 这个动态解析的可选平台包 → 打包态报 "Native CLI binary for win32-x64 not
 * found"。prepare-tauri 把该二进制拷进 bin/,这里解析它并经 options.pathToClaudeCodeExecutable 显式喂给
 * SDK(SDK 文档给的逃生口)。开发态返回 null → 让 SDK 自行解析已装好的平台包。
 */
export function getBundledClaudeCliPath(): string | null {
  if (process.env.FINANCE_AGENT_CLAUDE_CLI_PATH) return process.env.FINANCE_AGENT_CLAUDE_CLI_PATH;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const bundled = path.join(getProjectRoot(), "bin", exe);
  return fs.existsSync(bundled) ? bundled : null;
}

function getDefaultAppDataRoot() {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}
