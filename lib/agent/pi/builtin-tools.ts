import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { isBashSandboxAvailable, wrapCommandWithSandbox } from "@/lib/agent/tools/bash-sandbox";
import { resolveLibreOffice } from "@/lib/runtime/libreoffice-resolver";
import { getPythonBinDir, getPythonVenvRoot } from "@/lib/runtime/paths";
import type { AgentQuestion } from "@/lib/agent/contracts";
import { createPiAskUserQuestionTool } from "@/lib/agent/pi/ask-user-tool";

/**
 * Finwork 自行构造的 Pi 会话工具：受控文件/shell 工具，以及存在交互通道时的提问工具。
 *
 * 不用 Pi 的默认内置集（`noTools: "builtin"` 仍然保持开启）：默认集的 cwd 是项目根，
 * 对财务应用没有意义。这里按会话目录构造，让**缺省行为**落在会话内。
 *
 * **但构造不是围栏。** 核实过 pi 源码：这个参数在工具内部叫 `cwd`，只经
 * `resolveToCwd` 做相对路径解析，绝对路径与 `../` 都直接放行。真正的边界只有
 * `extension.ts` 的 `tool_call` 闸（写类/读类各自的根校验）与 bash 的 OS 沙箱。
 * 早先注释说这是「构造层的结构性事实」，属于夸大，已订正——这正是 L1b 批评过的虚假安全感。
 */

export type FinworkBuiltinRoots = {
  /** 写类工具（write/edit）的根：本回合会话输出目录。 */
  writeRoot: string;
  /** 读类工具（read/grep/find/ls、bash cwd）的根：会话文件目录，比 writeRoot 宽一级，含用户上传件。 */
  readRoot: string;
  /** Bash 额外的只读附件根；不扩大 write/edit 的写入范围。 */
  readRoots?: string[];
  /**
   * L4：技能根目录，只读放行。技能正文与其 `references/`、`scripts/` 都在这里；
   * 不放行的话「渐进披露」是断的——SKILL.md 叫模型去看 `scripts/xxx.py`，
   * 而模型没有任何工具读得到（实测三类技能文件全被闸拒）。
   */
  skillRoots?: string[];
};

/** 读类：只看不改，可及范围含技能目录。 */
export const FINWORK_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
/** 写类：只能落在本回合输出目录。 */
export const FINWORK_WRITE_TOOL_NAMES = ["write", "edit"] as const;

export const FINWORK_BUILTIN_TOOL_NAMES = [
  ...FINWORK_READ_TOOL_NAMES,
  ...FINWORK_WRITE_TOOL_NAMES,
  "bash",
] as const;

export type FinworkBuiltinToolName = (typeof FINWORK_BUILTIN_TOOL_NAMES)[number];

export type FinworkBuiltinToolOptions = {
  resolveUserQuestion?: (question: AgentQuestion) => Promise<string>;
};

export function isFinworkBuiltinTool(name: string): name is FinworkBuiltinToolName {
  return (FINWORK_BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 惰性构造：Pi 是纯 ESM，顶层 import 会经 tsx CJS 链报
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`，与 `lib/agent/pi/**` 其余边界文件的既有做法一致。
 */
export async function createFinworkBuiltinTools(
  roots: FinworkBuiltinRoots,
  options: FinworkBuiltinToolOptions = {},
): Promise<ToolDefinition[]> {
  const {
    createReadToolDefinition,
    createWriteToolDefinition,
    createEditToolDefinition,
    createBashToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  } = await import("@earendil-works/pi-coding-agent");
  const tools: ToolDefinition[] = [
    createReadToolDefinition(roots.readRoot),
    // grep/find/ls 的 path 可省略，省略时就落在这个 cwd（会话目录），是安全缺省。
    createGrepToolDefinition(roots.readRoot),
    createFindToolDefinition(roots.readRoot),
    createLsToolDefinition(roots.readRoot),
    createWriteToolDefinition(roots.writeRoot),
    createEditToolDefinition(roots.writeRoot),
  ] as ToolDefinition[];

  // Pi 本身没有模型可调用的 AskUserQuestion 内置工具。只有实时交互通道或
  // benchmark 的人工决策 resolver 存在时才注册，避免在无人接听的通道里伪装可用。
  if (options.resolveUserQuestion) {
    tools.push(createPiAskUserQuestionTool(options.resolveUserQuestion));
  }

  // fail-closed：没有 OS 沙箱就不给 bash。read/write/edit 的约束是结构性的
  // （构造层钉死根 + tool_call 路径校验），bash 的约束只能来自沙箱——拿不到就不注册，
  // 而不是退回正则黑名单假装有闸。
  if (isBashSandboxAvailable()) {
    const pythonBinDir = getPythonBinDir();
    const pythonVenvRoot = getPythonVenvRoot();
    // standalone runtime 是 <root>/bin/python；venv 则由 pyvenv.cfg 精确识别。
    const pythonRuntimeRoot = pythonVenvRoot ?? path.dirname(pythonBinDir);
    const libreOffice = resolveLibreOffice();
    const libreOfficeRuntimeRoot = libreOffice.ok
      ? resolveLibreOfficeRuntimeRoot(libreOffice.executable)
      : undefined;
    tools.push(
      createBashToolDefinition(roots.writeRoot, {
        // cwd 钉死在会话输出目录：模型写 `report.md` 落在会话里，而不是项目根或用户家目录。
        // 命令本身再包一层沙箱，绝对路径与等价改写都由内核按系统调用拦。
        spawnHook: ({ command, env }) => ({
          command: wrapCommandWithSandbox(command, {
            readRoot: roots.readRoot,
            readRoots: [
              ...(roots.readRoots ?? []),
              // Skill 正文可引用 scripts/references/assets；read 工具已放行这些根，
              // Bash 也必须能执行/读取同一套只读资源。
              ...(roots.skillRoots ?? []),
              // venv 的解释器、site-packages 和 console scripts 必须在 OS
              // sandbox 中可读；仅改 PATH 会因沙箱不可达而静默回退到系统 Python。
              pythonRuntimeRoot,
              // 受控 LibreOffice 通常是 dependencies/bin/override 下的 wrapper，
              // 实体在同一 dependencies/native 中；整个 runtime 根都要只读可达。
              ...(libreOfficeRuntimeRoot ? [libreOfficeRuntimeRoot] : []),
            ],
            writeRoot: roots.writeRoot,
          }),
          cwd: roots.writeRoot,
          env: {
            ...env,
            // Bash 与固定 worker 必须使用同一受控 Python runtime。只设置
            // FINANCE_AGENT_PYTHON_PATH 不会改变 shell 的 python/python3 解析。
            PATH: [
              pythonBinDir,
              // pi 会传入自己的 PATH；它可能比启动 Finwork 时的 PATH 更窄。
              // 两者都保留，才能让评测/桌面进程显式注入的 LibreOffice 等
              // 受控运行时继续对模型侧 Bash 可见。
              process.env.PATH,
              env.PATH,
            ].filter(Boolean).join(path.delimiter),
            ...(pythonVenvRoot ? { VIRTUAL_ENV: pythonVenvRoot } : {}),
            FINWORK_SESSION_OUTPUT_DIR: roots.writeRoot,
          },
        }),
      }) as ToolDefinition,
    );
  }

  return tools;
}

function resolveLibreOfficeRuntimeRoot(executable: string): string | undefined {
  let resolved = executable;
  try {
    resolved = fs.realpathSync(executable);
  } catch {
    // Resolver 已验证存在；realpath 失败时仍可按原路径推导。
  }
  const normalized = path.normalize(resolved);
  const dependenciesMarker = `${path.sep}dependencies${path.sep}`;
  const dependenciesIndex = normalized.indexOf(dependenciesMarker);
  if (dependenciesIndex >= 0) {
    return normalized.slice(
      0,
      dependenciesIndex + dependenciesMarker.length - path.sep.length,
    );
  }
  const appIndex = normalized.indexOf(".app" + path.sep);
  if (appIndex >= 0) return normalized.slice(0, appIndex + ".app".length);
  const parent = path.dirname(normalized);
  return parent === path.parse(parent).root ? undefined : parent;
}
