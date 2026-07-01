/**
 * 语义图标别名:给「有含义、多处复用或曾漂移」的概念一个统一入口。
 * 想改「成功用哪个勾」「刷新用哪个图标」,只改这里一处,全站跟着变。
 *
 * 只覆盖 app 业务代码用的 hugeicons;components/ui 里的 shadcn 基元用 phosphor,
 * 是另一套约定,不并进来(混在一起反而破坏 shadcn 的自带风格)。
 *
 * 约定:一次性、只在某处出现一次的图标仍各自 import;
 * 只有「代表某种含义、会在多处出现或可能漂移」的才收进这里。
 */
export {
  RefreshIcon, // 刷新 / 重新加载
  Tick02Icon as SuccessIcon, // 内联「完成 / 通过 / valid」对勾(无圈)
  // 「成功状态」圆圈勾(状态徽标):原 knowledge 用 01、callout 用 02,统一到 02。
  CheckmarkCircle02Icon as SuccessCircleIcon,
  Alert02Icon as WarningIcon, // 警告 / 校验失败
  HelpCircleIcon as HelpIcon, // 帮助 / 说明
  Copy01Icon as CopyIcon, // 复制
  InformationCircleIcon as InfoIcon, // 信息 / 提示
} from "@hugeicons/core-free-icons";
