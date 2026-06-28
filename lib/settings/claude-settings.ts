import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSettingsPath } from "@/lib/runtime/paths";
import { getApiKeySecret, setApiKeySecret } from "@/lib/settings/secret-store";

export type RoleMode = "daily" | "tech";

export type ClaudeSettings = {
  apiUrl: string;
  apiKey: string;
  model: string;
  companyName: string;
  agentName: string;
  /** Haiku model for router/intent classification (WP2) */
  routerModel: string;
  /** Model for subagent tasks (WP8 cost routing) */
  subagentModel: string;
  /** Primary model for complex main-agent tasks */
  mainModel: string;
  /** UI/response style mode */
  roleMode: RoleMode;
  /** 匿名遥测开关,默认 true(§17.2);无内置 endpoint 时 reporter 自动 no-op,安全 */
  telemetryEnabled: boolean;
  /** 遥测上报端点,如 https://your-telemetry.example.com */
  telemetryEndpoint: string;
  /** 遥测鉴权 token(Bearer) */
  telemetryToken: string;
  /** 匿名安装 ID,首次生成后持久化;永不绑定真实身份 */
  telemetryInstallId: string;
};

export type PublicClaudeSettings = {
  apiUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyPreview: string;
  /** 上次写入是否成功落库;false 表示密钥库写入失败,密钥未持久化。 */
  apiKeyPersisted: boolean;
  companyName: string;
  agentName: string;
  routerModel: string;
  subagentModel: string;
  mainModel: string;
  roleMode: RoleMode;
  telemetryEnabled: boolean;
  telemetryEndpoint: string;
  telemetryToken: string;
  telemetryInstallId: string;
};

const defaultSettings: ClaudeSettings = {
  apiUrl: "https://api.anthropic.com",
  apiKey: "",
  model: "",
  companyName: "",
  agentName: "小财",
  routerModel: "",
  subagentModel: "",
  mainModel: "",
  // 主用户是非技术财务:默认走 daily(过程翻译成中文摘要、不暴露 JSON/thinking)。
  // 技术用户可在 设置 切回 tech 看全量细节。已存设置不受影响(下方 merge 保留原值)。
  roleMode: "daily",
  // 遥测默认开(§17.2):无内置 endpoint 的 dev 构建 reporter 自动 no-op;首启告知代替阻塞弹框。
  telemetryEnabled: true,
  telemetryEndpoint: "",
  telemetryToken: "",
  telemetryInstallId: "",
};

export async function readClaudeSettings(): Promise<ClaudeSettings> {
  let parsed: (Partial<ClaudeSettings> & { claude?: Partial<ClaudeSettings> }) | null = null;
  let source: Partial<ClaudeSettings> = {};
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf-8");
    parsed = JSON.parse(raw) as Partial<ClaudeSettings> & { claude?: Partial<ClaudeSettings> };
    source = parsed.claude ?? parsed;
  } catch {
    // 文件不存在/损坏:用默认值;API Key 仍可能在系统密钥库里
  }

  // API Key 一律从系统密钥库取;若 JSON 里还留着旧版明文 key,迁移进密钥库并从 JSON 抹掉。
  let apiKey = (await getApiKeySecret()).trim();
  const legacyKey = (source.apiKey || "").trim();
  if (!apiKey && legacyKey) {
    apiKey = legacyKey;
    await migrateLegacyKey(legacyKey, parsed, source);
  }

  // 首次读取时若无 installId 则生成并立即持久化(保证多次读取 installId 不变)。
  let telemetryInstallId = (source.telemetryInstallId || "").trim();
  if (!telemetryInstallId) {
    telemetryInstallId = randomUUID();
    // 写回设置文件以持久化;失败时 best-effort(不阻塞启动)。
    try {
      const nextSource = { ...source, telemetryInstallId };
      const out = parsed && parsed.claude ? { ...parsed, claude: nextSource } : { claude: nextSource };
      const settingsPath = getSettingsPath();
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, `${JSON.stringify(out, null, 2)}
`, 'utf-8');
    } catch {
      // best-effort
    }
  }

  return {
    apiUrl: source.apiUrl || defaultSettings.apiUrl,
    apiKey,
    model: source.model || "",
    companyName: source.companyName || "",
    agentName: source.agentName || defaultSettings.agentName,
    routerModel: source.routerModel || defaultSettings.routerModel,
    subagentModel: source.subagentModel || defaultSettings.subagentModel,
    mainModel: source.mainModel || defaultSettings.mainModel,
    roleMode: source.roleMode === "daily" || source.roleMode === "tech" ? source.roleMode : defaultSettings.roleMode,
    // §17.2 默认开:已存设置明确写了 false 就尊重;未配置(undefined)退到 default(true)。
    telemetryEnabled: source.telemetryEnabled !== undefined ? source.telemetryEnabled === true : defaultSettings.telemetryEnabled,
    telemetryEndpoint: (source.telemetryEndpoint || "").trim(),
    telemetryToken: (source.telemetryToken || "").trim(),
    telemetryInstallId,
  };
}

export async function writeClaudeSettings(next: Partial<ClaudeSettings>) {
  const current = await readClaudeSettings();
  const settingsPath = getSettingsPath();
  const settings: ClaudeSettings = {
    apiUrl: normalizeApiUrl(next.apiUrl ?? current.apiUrl),
    apiKey: (next.apiKey ?? current.apiKey).trim(),
    model: normalizeModel(next.model ?? current.model),
    companyName: next.companyName?.trim() ?? current.companyName,
    agentName: next.agentName?.trim() || current.agentName || defaultSettings.agentName,
    routerModel: (next.routerModel || current.routerModel || defaultSettings.routerModel).trim(),
    subagentModel: (next.subagentModel || current.subagentModel || defaultSettings.subagentModel).trim(),
    mainModel: (next.mainModel || current.mainModel || defaultSettings.mainModel).trim(),
    roleMode: next.roleMode === "daily" || next.roleMode === "tech" ? next.roleMode : (current.roleMode || defaultSettings.roleMode),
    telemetryEnabled: next.telemetryEnabled !== undefined ? next.telemetryEnabled : current.telemetryEnabled,
    telemetryEndpoint: (next.telemetryEndpoint ?? current.telemetryEndpoint).trim(),
    telemetryToken: (next.telemetryToken ?? current.telemetryToken).trim(),
    // installId 一旦生成后永不被覆盖(除非显式传入非空值)。
    telemetryInstallId: next.telemetryInstallId?.trim() || current.telemetryInstallId || randomUUID(),
  };

  // API Key 进系统密钥库,绝不写进 settings JSON(空串=清除)。
  const apiKeyPersisted = await setApiKeySecret(settings.apiKey);

  // 显式列出落盘字段(白名单),保证 apiKey 永不出现在 JSON 里。
  const jsonPayload: Omit<ClaudeSettings, "apiKey"> = {
    apiUrl: settings.apiUrl,
    model: settings.model,
    companyName: settings.companyName,
    agentName: settings.agentName,
    routerModel: settings.routerModel,
    subagentModel: settings.subagentModel,
    mainModel: settings.mainModel,
    roleMode: settings.roleMode,
    telemetryEnabled: settings.telemetryEnabled,
    telemetryEndpoint: settings.telemetryEndpoint,
    telemetryToken: settings.telemetryToken,
    telemetryInstallId: settings.telemetryInstallId,
  };
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify({ claude: jsonPayload }, null, 2)}\n`, "utf-8");
  return toPublicClaudeSettings(settings, apiKeyPersisted);
}

/** 旧版本把明文 key 存在 settings JSON 里;首次读到就迁进密钥库并从 JSON 抹掉(best-effort)。 */
async function migrateLegacyKey(
  key: string,
  parsed: (Partial<ClaudeSettings> & { claude?: Partial<ClaudeSettings> }) | null,
  source: Partial<ClaudeSettings>,
): Promise<void> {
  try {
    await setApiKeySecret(key);
    delete (source as { apiKey?: string }).apiKey; // source 指向 parsed.claude 或 parsed,改它即改 parsed
    const out = parsed && parsed.claude ? parsed : { claude: source };
    const settingsPath = getSettingsPath();
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
  } catch (err) {
    console.warn("[claude-settings] 旧版明文 key 迁移失败", err);
  }
}

export async function readPublicClaudeSettings() {
  return toPublicClaudeSettings(await readClaudeSettings());
}

export function toPublicClaudeSettings(settings: ClaudeSettings, apiKeyPersisted = true): PublicClaudeSettings {
  return {
    apiUrl: settings.apiUrl,
    model: settings.model,
    apiKeyConfigured: settings.apiKey.trim().length > 0,
    apiKeyPreview: maskApiKey(settings.apiKey),
    apiKeyPersisted,
    companyName: settings.companyName,
    agentName: settings.agentName,
    routerModel: settings.routerModel,
    subagentModel: settings.subagentModel,
    mainModel: settings.mainModel,
    roleMode: settings.roleMode,
    telemetryEnabled: settings.telemetryEnabled,
    telemetryEndpoint: settings.telemetryEndpoint,
    telemetryToken: settings.telemetryToken,
    telemetryInstallId: settings.telemetryInstallId,
  };
}

function normalizeApiUrl(value: string) {
  return value.trim().replace(/\/+$/, "") || defaultSettings.apiUrl;
}

function normalizeModel(value: string) {
  return value.trim();
}

function maskApiKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "已配置";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
