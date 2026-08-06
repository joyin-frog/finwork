import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSettingsPath } from "@/lib/runtime/paths";
import { getApiKeySecret, setApiKeySecret } from "@/lib/settings/secret-store";
import { migrateModelConfig, type ModelConfigV2 } from "@/lib/settings/model-config";
import { parseModelPricing, type ModelPricingConfig } from "@/lib/agent/pi/model-catalog";

export type RoleMode = "daily" | "tech";

export type AgentSettings = {
  apiUrl: string;
  apiKey: string;
  model: string;
  companyName: string;
  agentName: string;
  /** 当前用户显示名(侧栏底部头像行、可留空) */
  userName: string;
  /** 当前用户头像:小尺寸 data URL(客户端已压到 ~96px);空串=用姓名首字兜底 */
  userAvatar: string;
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
  /**
   * 每模型费率与上下文上限(可选,按 model id 索引)。费率单位 USD/百万 token。
   * 模型与网关都是用户自填的,Finwork 无从知道价格,所以不内置价格表:声明了才算真实成本,
   * 未声明时 totalCostUsd 报 null(未知)而不是 0(免费)。无 UI,直接编辑 settings.json。
   */
  modelPricing?: ModelPricingConfig;
};

export type PublicAgentSettings = {
  apiUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyPreview: string;
  /** 上次写入是否成功落库;false 表示密钥库写入失败,密钥未持久化。 */
  apiKeyPersisted: boolean;
  companyName: string;
  agentName: string;
  userName: string;
  userAvatar: string;
  routerModel: string;
  subagentModel: string;
  mainModel: string;
  roleMode: RoleMode;
  telemetryEnabled: boolean;
  telemetryEndpoint: string;
  telemetryToken: string;
  telemetryInstallId: string;
};

const defaultSettings: AgentSettings = {
  apiUrl: "https://api.anthropic.com",
  apiKey: "",
  model: "",
  companyName: "",
  agentName: "小财",
  userName: "",
  userAvatar: "",
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

type SettingsEnvelope = Partial<AgentSettings> & {
  agent?: Partial<AgentSettings>;
  claude?: Partial<AgentSettings>;
};

/** 信封解包层数上限;正常最多 1 层,多出来的是历史畸形文件,不能无限下钻。 */
const MAX_ENVELOPE_DEPTH = 4;

function isEnvelopeLayer(value: unknown): value is SettingsEnvelope {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 逐层解开设置信封,返回真正承载字段的那一层。
 *
 * 磁盘上出现过三种形态:`{agent:…}`(当前写入格式)、`{claude:…}`(旧版),以及双层的
 * `{claude:{agent:…}}`。第三种曾让 source 停在中间层——那层没有 apiUrl/mainModel 等
 * 字段,于是全部读成 undefined 并**静默**回落默认值:用户在设置页填过的 API 地址、
 * 模型、公司名凭空消失,界面上却毫无报错,只显示成"没配过"。
 *
 * AgentSettings 自身没有 agent/claude 字段(是 agentName),所以"还能继续下钻"
 * 等价于"当前这层是信封",不会误伤真实设置。
 */
function unwrapSettingsEnvelope(parsed: SettingsEnvelope | null): {
  source: Partial<AgentSettings>;
  /** 是否已是写入器产出的规范形态;false 时调用方需幂等写回,避免旧形态永久滞留。 */
  canonical: boolean;
} {
  if (!parsed) return { source: {}, canonical: true };
  let current: SettingsEnvelope = parsed;
  let depth = 0;
  let viaLegacyKey = false;
  while (depth < MAX_ENVELOPE_DEPTH) {
    let next: SettingsEnvelope | null = null;
    if (isEnvelopeLayer(current.agent)) {
      next = current.agent;
    } else if (isEnvelopeLayer(current.claude)) {
      next = current.claude;
      viaLegacyKey = true;
    }
    if (!next) break;
    current = next;
    depth += 1;
  }
  // 规范形态只有两种:裸对象(depth 0)与单层 {agent:…}(depth 1)。
  // 走过 claude 或多于一层,都说明磁盘形态过时,需要写回。
  return { source: current, canonical: !viaLegacyKey && depth <= 1 };
}

/** 只有「文件不存在」才是可以按默认值创建的正常首启;其余读失败一律视为磁盘有数据但读不动。 */
function isFileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * 原子落盘:同目录临时文件 + rename。
 *
 * 直接 writeFile 会让并发读者看到写了一半的 JSON;而读侧一旦解析失败就会拿默认值
 * 写回,构成真实的数据丢失链。2026-08-05 实测:一次并发读写把设置文件打成只剩
 * 一个键。rename 在同一目录内是原子的,读者要么看到旧文件、要么看到新文件。
 */
async function writeSettingsFileAtomic(payload: unknown): Promise<void> {
  const settingsPath = getSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await fs.rename(tempPath, settingsPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readAgentSettings(): Promise<AgentSettings> {
  let parsed: SettingsEnvelope | null = null;
  let source: Partial<AgentSettings> = {};
  let canonicalEnvelope = true;
  // 文件缺失 ≠ 读不动。前者是首启,可以按默认值创建;后者说明磁盘上有内容但当前
  // 读不了(半写、损坏、无权限),此时任何写回都会拿默认值覆盖掉用户的真实设置。
  let readFailed = false;
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf-8");
    parsed = JSON.parse(raw) as SettingsEnvelope;
    ({ source, canonical: canonicalEnvelope } = unwrapSettingsEnvelope(parsed));
  } catch (error) {
    readFailed = !isFileMissing(error);
  }
  const loadedLegacyEnvelope = !canonicalEnvelope;

  // API Key 一律从系统密钥库取;若 JSON 里还留着旧版明文 key,迁移进密钥库并从 JSON 抹掉。
  let apiKey = (await getApiKeySecret()).trim();
  const legacyKey = (source.apiKey || "").trim();
  if (!apiKey && legacyKey) {
    apiKey = legacyKey;
    await migrateLegacyKey(legacyKey, parsed, source);
  }

  // 首次读取时若无 installId 则生成并立即持久化(保证多次读取 installId 不变)。
  //
  // readFailed 时**只在内存里用新 id,绝不落盘**:这条路径曾把一份读不动的设置文件
  // 覆盖成只剩 installId 一个键(2026-08-05 实测)。读不出来就不写,等下次读成功。
  let telemetryInstallId = (source.telemetryInstallId || "").trim();
  if (!telemetryInstallId) {
    telemetryInstallId = randomUUID();
    if (!readFailed) {
      // 写回设置文件以持久化;失败时 best-effort(不阻塞启动)。
      try {
        await writeSettingsFileAtomic({ agent: { ...source, telemetryInstallId } });
      } catch {
        // best-effort
      }
    }
  }

  // CR-M1: 旧三槽/legacy model → 原子 ModelConfig v2；不完整则为空槽(null 语义)。
  const migrated = migrateModelConfig({
    mainModel: source.mainModel,
    routerModel: source.routerModel,
    subagentModel: source.subagentModel,
    model: source.model,
  });
  const modelSlots = migrated ?? { mainModel: "", routerModel: "", subagentModel: "" };

  // 迁移成功且磁盘仍是旧形态时，幂等写回完整 v2(best-effort)。
  if (migrated && needsModelConfigPersist(source, migrated)) {
    try {
      await persistMigratedModelConfig(parsed, source, migrated, telemetryInstallId);
    } catch {
      // best-effort
    }
  }

  const settings: AgentSettings = {
    apiUrl: source.apiUrl || defaultSettings.apiUrl,
    apiKey,
    // settings.model 只参与一次迁移；运行时选择不再读它。保留原值供兼容展示。
    model: source.model || "",
    companyName: source.companyName || "",
    agentName: source.agentName || defaultSettings.agentName,
    userName: source.userName || "",
    userAvatar: normalizeAvatar(source.userAvatar),
    routerModel: modelSlots.routerModel,
    subagentModel: modelSlots.subagentModel,
    mainModel: modelSlots.mainModel,
    roleMode: source.roleMode === "daily" || source.roleMode === "tech" ? source.roleMode : defaultSettings.roleMode,
    // §17.2 默认开:已存设置明确写了 false 就尊重;未配置(undefined)退到 default(true)。
    telemetryEnabled: source.telemetryEnabled !== undefined ? source.telemetryEnabled === true : defaultSettings.telemetryEnabled,
    telemetryEndpoint: (source.telemetryEndpoint || "").trim(),
    telemetryToken: (source.telemetryToken || "").trim(),
    telemetryInstallId,
    modelPricing: parseModelPricing((source as { modelPricing?: unknown }).modelPricing),
  };
  if (loadedLegacyEnvelope) {
    try {
      await persistAgentEnvelope(settings);
    } catch {
      // best-effort；旧版本配置仍可继续读取，下次启动重试迁移
    }
  }
  return settings;
}

export async function writeAgentSettings(next: Partial<AgentSettings>) {
  const current = await readAgentSettings();
  const settingsPath = getSettingsPath();
  const modelSlots = resolveAtomicModelWrite(next, current);
  const settings: AgentSettings = {
    apiUrl: normalizeApiUrl(next.apiUrl ?? current.apiUrl),
    apiKey: (next.apiKey ?? current.apiKey).trim(),
    model: normalizeModel(next.model ?? current.model),
    companyName: next.companyName?.trim() ?? current.companyName,
    agentName: next.agentName?.trim() || current.agentName || defaultSettings.agentName,
    userName: next.userName?.trim() ?? current.userName,
    userAvatar: next.userAvatar !== undefined ? normalizeAvatar(next.userAvatar) : current.userAvatar,
    routerModel: modelSlots.routerModel,
    subagentModel: modelSlots.subagentModel,
    mainModel: modelSlots.mainModel,
    roleMode: next.roleMode === "daily" || next.roleMode === "tech" ? next.roleMode : (current.roleMode || defaultSettings.roleMode),
    telemetryEnabled: next.telemetryEnabled !== undefined ? next.telemetryEnabled : current.telemetryEnabled,
    telemetryEndpoint: (next.telemetryEndpoint ?? current.telemetryEndpoint).trim(),
    telemetryToken: (next.telemetryToken ?? current.telemetryToken).trim(),
    // installId 一旦生成后永不被覆盖(除非显式传入非空值)。
    telemetryInstallId: next.telemetryInstallId?.trim() || current.telemetryInstallId || randomUUID(),
    // 无 UI 写入路径;写设置时原样保留磁盘上的声明,不被 Partial 覆盖掉。
    modelPricing: next.modelPricing ?? current.modelPricing,
  };

  // API Key 进系统密钥库,绝不写进 settings JSON(空串=清除)。
  const apiKeyPersisted = await setApiKeySecret(settings.apiKey);

  // 显式列出落盘字段(白名单),保证 apiKey 永不出现在 JSON 里。
  const jsonPayload: Omit<AgentSettings, "apiKey"> = {
    apiUrl: settings.apiUrl,
    model: settings.model,
    companyName: settings.companyName,
    agentName: settings.agentName,
    userName: settings.userName,
    userAvatar: settings.userAvatar,
    routerModel: settings.routerModel,
    subagentModel: settings.subagentModel,
    mainModel: settings.mainModel,
    roleMode: settings.roleMode,
    telemetryEnabled: settings.telemetryEnabled,
    telemetryEndpoint: settings.telemetryEndpoint,
    telemetryToken: settings.telemetryToken,
    telemetryInstallId: settings.telemetryInstallId,
    // 白名单漏了它就会在每次写设置时静默删掉用户手写的费率声明。
    ...(settings.modelPricing ? { modelPricing: settings.modelPricing } : {}),
  };
  await writeSettingsFileAtomic({ agent: jsonPayload });
  return toPublicAgentSettings(settings, apiKeyPersisted);
}

/** 旧版本把明文 key 存在 settings JSON 里;首次读到就迁进密钥库并从 JSON 抹掉(best-effort)。 */
async function migrateLegacyKey(
  key: string,
  parsed: (Partial<AgentSettings> & { agent?: Partial<AgentSettings>; claude?: Partial<AgentSettings> }) | null,
  source: Partial<AgentSettings>,
): Promise<void> {
  try {
    await setApiKeySecret(key);
    delete (source as { apiKey?: string }).apiKey; // source 指向解包后的真实设置对象,改它即改 parsed
    await writeSettingsFileAtomic({ agent: source });
  } catch (err) {
    console.warn("[agent-settings] 旧版明文 key 迁移失败", err);
  }
}

export async function readPublicAgentSettings() {
  return toPublicAgentSettings(await readAgentSettings());
}

export function toPublicAgentSettings(settings: AgentSettings, apiKeyPersisted = true): PublicAgentSettings {
  return {
    apiUrl: settings.apiUrl,
    model: settings.model,
    apiKeyConfigured: settings.apiKey.trim().length > 0,
    apiKeyPreview: maskApiKey(settings.apiKey),
    apiKeyPersisted,
    companyName: settings.companyName,
    agentName: settings.agentName,
    userName: settings.userName,
    userAvatar: settings.userAvatar,
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

/**
 * 原子模型写入：
 * - 未传任何模型字段 → 保留当前三槽
 * - 传入任一模型字段 → 必须三槽齐全(调用方 API 已校验)；禁止用旧值填空伪装成功
 */
function resolveAtomicModelWrite(
  next: Partial<AgentSettings>,
  current: AgentSettings,
): Pick<AgentSettings, "mainModel" | "routerModel" | "subagentModel"> {
  const touching =
    next.mainModel !== undefined || next.routerModel !== undefined || next.subagentModel !== undefined;
  if (!touching) {
    return {
      mainModel: current.mainModel,
      routerModel: current.routerModel,
      subagentModel: current.subagentModel,
    };
  }
  // API 保证要么完整 v2、要么根本不写；此处不再用 current 填空。
  return {
    mainModel: (next.mainModel ?? "").trim(),
    routerModel: (next.routerModel ?? "").trim(),
    subagentModel: (next.subagentModel ?? "").trim(),
  };
}

function needsModelConfigPersist(
  source: Partial<AgentSettings>,
  migrated: ModelConfigV2,
): boolean {
  return (
    source.mainModel !== migrated.mainModel ||
    source.routerModel !== migrated.routerModel ||
    source.subagentModel !== migrated.subagentModel
  );
}

async function persistMigratedModelConfig(
  _parsed: (Partial<AgentSettings> & { agent?: Partial<AgentSettings>; claude?: Partial<AgentSettings> }) | null,
  source: Partial<AgentSettings>,
  migrated: ModelConfigV2,
  telemetryInstallId: string,
): Promise<void> {
  const nextSource = {
    ...source,
    mainModel: migrated.mainModel,
    routerModel: migrated.routerModel,
    subagentModel: migrated.subagentModel,
    telemetryInstallId,
  };
  await writeSettingsFileAtomic({ agent: nextSource });
}

async function persistAgentEnvelope(settings: AgentSettings): Promise<void> {
  const jsonPayload: Partial<AgentSettings> = { ...settings };
  delete jsonPayload.apiKey;
  await writeSettingsFileAtomic({ agent: jsonPayload });
}

// 头像只接受小图 data URL(客户端已压到 ~96px);非 data:image/ 前缀或超过 512KB 一律丢弃,
// 防脏值/超大串撑爆 settings.json。空串合法(表示清空,用姓名首字兜底)。
function normalizeAvatar(value: string | undefined): string {
  const v = (value || "").trim();
  if (!v) return "";
  if (!v.startsWith("data:image/")) return "";
  if (v.length > 512 * 1024) return "";
  return v;
}

function maskApiKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "已配置";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
