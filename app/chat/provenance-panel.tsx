import { HugeiconsIcon } from "@hugeicons/react";
import { SecurityCheckIcon, Alert02Icon, File01Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { Callout } from "@/app/components/callout";
import type { ReimbursementProvenance } from "@/app/chat/provenance";

/**
 * 报销溯源块(C3):统一走 info 档 Callout(系统核验标题 + 数据来源/口径/笔数列表),
 * 脚注点明"以上为系统记录,结论由 AI 依据这些来源生成",让财务一眼分清"系统担保"与"AI 自述"。
 */
export function ProvenancePanel({ provenance }: { provenance: ReimbursementProvenance }) {
  const { sources, policyBasis, counts } = provenance;
  if (!sources.length && !policyBasis && !counts.length) return null;

  return (
    <Callout variant="info" icon={SecurityCheckIcon} title="数据来源 · 系统核验">
      <div className="flex flex-col gap-2">
        {policyBasis ? (
          <div className={policyBasis.isExample ? "flex items-start gap-2 text-[color:var(--tone-alarm)]" : "flex items-start gap-2 text-muted-foreground"}>
            {policyBasis.isExample
              ? <HugeiconsIcon icon={Alert02Icon} size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
              : <HugeiconsIcon icon={File01Icon} size={13} className="shrink-0 mt-0.5" aria-hidden="true" />}
            <span>{policyBasis.text}</span>
          </div>
        ) : null}
        {sources.map((s) => (
          <div key={s} className="flex items-start gap-2 text-muted-foreground">
            <HugeiconsIcon icon={File01Icon} size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>{s}</span>
          </div>
        ))}
        {counts.map((c) => (
          <div key={c} className="flex items-start gap-2 text-muted-foreground">
            <HugeiconsIcon icon={CheckListIcon} size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>{c}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-caption text-muted-foreground/70">
        以上为系统记录的实际来源与口径;结论与口径说明由 AI 依据这些来源生成,请按需复核。
      </p>
    </Callout>
  );
}
