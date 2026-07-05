import {
  ConfigurationIcon,
  BotIcon,
  BrainIcon,
  InformationCircleIcon,
  PaintBoardIcon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";

/**
 * 设置页的标签单一源:菜单渲染(skill-center)与 URL 校验(page.tsx)都从这里取,
 * 避免改标签时两处不同步导致深链 ?tab=xxx 静默回退到「常规」。
 */
export const CONFIG_TABS = [
  { key: "general", label: "常规", icon: ConfigurationIcon },
  { key: "appearance", label: "外观", icon: PaintBoardIcon },
  { key: "personalization", label: "个性化", icon: BrainIcon },
  { key: "model", label: "模型", icon: BotIcon },
  { key: "shortcuts", label: "键盘快捷键", icon: KeyboardIcon },
  { key: "about", label: "关于", icon: InformationCircleIcon },
] as const;

export type ConfigTabKey = (typeof CONFIG_TABS)[number]["key"];

export const CONFIG_TAB_KEYS: readonly ConfigTabKey[] = CONFIG_TABS.map((t) => t.key);

/** 已移除标签的深链必须显式迁移，不能与未知 key 一样静默回退。 */
export const LEGACY_CONFIG_TAB_REDIRECTS = {
  understanding: "personalization",
  memory: "personalization",
  profile: "personalization",
  usage: "model",
} as const satisfies Record<string, ConfigTabKey>;
