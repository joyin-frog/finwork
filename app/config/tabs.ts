import {
  ConfigurationIcon,
  BotIcon,
  NoteIcon,
  BrainIcon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";

/**
 * 设置页的标签单一源:菜单渲染(skill-center)与 URL 校验(page.tsx)都从这里取,
 * 避免改标签时两处不同步导致深链 ?tab=xxx 静默回退到「常规」。
 */
export const CONFIG_TABS = [
  { key: "general", label: "常规", icon: ConfigurationIcon },
  { key: "model", label: "模型连接", icon: BotIcon },
  { key: "skills", label: "技能", icon: NoteIcon },
  { key: "understanding", label: "小财的了解", icon: BrainIcon },
  { key: "about", label: "关于", icon: InformationCircleIcon },
] as const;

export type ConfigTabKey = (typeof CONFIG_TABS)[number]["key"];

export const CONFIG_TAB_KEYS: readonly ConfigTabKey[] = CONFIG_TABS.map((t) => t.key);

/** 已移除标签的深链必须显式迁移，不能与未知 key 一样静默回退。 */
export const LEGACY_CONFIG_TAB_REDIRECTS = {
  appearance: "general",
  memory: "understanding",
  profile: "understanding",
  usage: "about",
} as const satisfies Record<string, ConfigTabKey>;
