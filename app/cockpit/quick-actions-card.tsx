"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calculator01Icon, ArrowRight01Icon, ClipboardIcon, ChartIncreaseIcon, DiscountTag01Icon } from "@hugeicons/core-free-icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trackFeature } from "@/lib/telemetry/track";

// 按当前重点排序:经营分析 / 税务筹划在前;报销/薪税/泛财务分析为周期性次要项,下移。
const quickActions = [
  { icon: ChartIncreaseIcon, title: "经营分析", desc: "四能力×三基准 + 趋势(金蝶财报)", tone: "var(--tone-skill)", href: "/chat/new?prompt=帮我做经营分析,我把金蝶导出的财务报表发给你", event: "feature.business_analysis.open" },
  { icon: DiscountTag01Icon, title: "税务筹划", desc: "查可享优惠/补贴/政策线索", tone: "var(--tone-skill)", href: "/chat/new?prompt=帮我看看公司能享受哪些税收优惠、补贴和政策", event: "feature.tax_planning.open" },
  { icon: ClipboardIcon, title: "报销校验", desc: "票据合规、跨月查重", tone: "var(--tone-invoice)", href: "/chat/new?prompt=请帮我校验报销单据", event: "feature.reimbursement.open" },
  { icon: Calculator01Icon, title: "薪税计算", desc: "累计预扣、草稿确认", tone: "var(--tone-payroll)", href: "/chat/new?prompt=请帮我计算本月薪资个税", event: "feature.payroll.open" },
  { icon: ChartIncreaseIcon, title: "财务分析", desc: "趋势、对比、归因", tone: "var(--tone-skill)", href: "/chat/new?prompt=请帮我分析财务数据", event: "feature.finance_analysis.open" },
] as const;

export function QuickActionsCard() {
  return (
    <Card>
      <CardHeader><CardTitle>快捷操作</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-1">
        {quickActions.map((a) => (
          <Link
            key={a.title}
            href={a.href}
            onClick={() => trackFeature(a.event)}
            className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent transition-colors group"
          >
            <div
              className="flex size-8 shrink-0 items-center justify-center rounded-md fa-toned"
              style={{ "--tone": a.tone } as CSSProperties}
            >
              <HugeiconsIcon icon={a.icon} size={16} aria-hidden />
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <span className="text-body font-medium">{a.title}</span>
              <span className="text-meta text-muted-foreground">{a.desc}</span>
            </div>
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-muted-foreground shrink-0" aria-hidden />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
