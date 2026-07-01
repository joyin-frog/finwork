import {
  PaintBoardIcon,
  ConfigurationIcon,
  BotIcon,
  BrainIcon,
  Building01Icon,
  BarChartIcon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";

/**
 * 设置页的标签单一源:菜单渲染(skill-center)与 URL 校验(page.tsx)都从这里取,
 * 避免改标签时两处不同步导致深链 ?tab=xxx 静默回退到「常规」。
 */
export const CONFIG_TABS = [
  { key: "appearance", label: "外观", icon: PaintBoardIcon },
  { key: "general", label: "常规", icon: ConfigurationIcon },
  { key: "model", label: "模型", icon: BotIcon },
  { key: "memory", label: "记忆", icon: BrainIcon },
  { key: "profile", label: "画像", icon: Building01Icon },
  { key: "usage", label: "用量", icon: BarChartIcon },
  { key: "about", label: "关于", icon: InformationCircleIcon },
] as const;

export type ConfigTabKey = (typeof CONFIG_TABS)[number]["key"];

export const CONFIG_TAB_KEYS: readonly ConfigTabKey[] = CONFIG_TABS.map((t) => t.key);
