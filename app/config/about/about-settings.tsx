"use client";

import { SettingsCard } from "@/app/config/settings-ui";
import { formatAppVersion } from "@/lib/version/format";
import { UpdaterBody } from "@/app/config/general/updater-settings";
import { RuntimeEnvBody } from "@/app/config/environment/environment-settings";
import { TelemetryBody } from "@/app/config/environment/telemetry-settings";

/** 「关于」页:版本信息 → 运行环境 → 使用数据上报,三大块各用卡片框起来。 */
export function AboutSettings() {
  return (
    <div className="flex flex-col gap-4">
      <SettingsCard title="版本信息" description="当前应用版本；桌面版可在此检查更新。">
        <div className="text-body">
          <span className="font-medium">当前版本：</span>
          <span className="text-muted-foreground">{formatAppVersion(process.env.NEXT_PUBLIC_APP_VERSION)}</span>
        </div>
        <UpdaterBody />
      </SettingsCard>

      <SettingsCard
        title="运行环境"
        description="基础功能（报销、薪税、对账、报表、知识库）开箱即用。复杂 Excel / PDF 的高级分析需要一次性安装分析组件。"
      >
        <RuntimeEnvBody />
      </SettingsCard>

      <SettingsCard
        title="使用数据上报（可选）"
        description="将匿名运行指标（token 用量/耗时/成本/错误/路由）上报以改进产品，不含财务数据。默认开启，可随时关闭。"
      >
        <TelemetryBody />
      </SettingsCard>
    </div>
  );
}
