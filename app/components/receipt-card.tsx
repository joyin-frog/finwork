import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { formatCny } from "@/lib/format";
import { validateCalcReceipt, type CalcReceipt, type CalcSource } from "@/lib/domain/receipt";

/**
 * 通用计算回执卡片：任何带 CalcReceipt 的工具结果都能渲染成可下钻明细。
 * 复用 payroll-result-card 的 <details> 折叠"计算过程"模式，统一回答财务三连问：
 * 从哪来（数据来源）/ 怎么算（计算过程）/ 按哪版口径、是不是终值（口径与结算状态）。
 *
 * 财务红线：settlementStatus=draft 必须显著标"未结账/会变,仅供参考",绝不让草稿看起来像终值；
 * 金额一律展示用元；界面只用财务语言,不出现 token/置信度/模型等 AI 术语。
 */

const STATUS_LABEL: Record<CalcReceipt["basis"]["settlementStatus"], string> = {
  draft: "未结账（草稿）",
  closed: "已结账",
  filed: "已申报",
};

const ROUNDING_LABEL: Record<CalcReceipt["rounding"], string> = {
  half_up: "四舍五入",
  bankers: "银行家舍入",
};

/**
 * 严格解析：仅当结构化结果确为 CalcReceipt 形状时返回，否则 null（回退纯文本）。
 * 复用 domain 校验器，避免卡片与数据契约口径漂移。
 */
export function parseCalcReceiptStructured(structured: unknown): CalcReceipt | null {
  try {
    return validateCalcReceipt(structured);
  } catch {
    return null;
  }
}

function formatSource(s: CalcSource): string {
  const parts: string[] = [];
  if (s.file) parts.push(s.file);
  if (s.ref) parts.push(s.ref);
  if (typeof s.recordCount === "number" && Number.isFinite(s.recordCount)) {
    parts.push(`共 ${s.recordCount} 条`);
  }
  return parts.length ? parts.join(" · ") : "（来源未标注）";
}

export function ReceiptCard({ receipt }: { receipt: CalcReceipt }) {
  const isDraft = receipt.basis.settlementStatus === "draft";

  return (
    <div className="rounded-lg border border-border bg-card text-body overflow-hidden">
      {/* 草稿红线：未结账数据显著标注,绝不当终值 */}
      {isDraft ? (
        <div className="px-3 py-2 border-b border-[color:var(--tone-notice)]/30 bg-[color:var(--tone-notice)]/12 text-meta flex items-start gap-2">
          <HugeiconsIcon icon={Alert02Icon} size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            <strong className="font-medium">未结账</strong> · 此为草稿数据，仍会变动，仅供参考，请勿据此对外申报或支付。
          </span>
        </div>
      ) : null}

      {/* 主数值 + 结算状态 */}
      <div className="px-3 py-2.5 border-b border-border flex items-baseline justify-between gap-3">
        <span className="text-h2 tabular-nums">{formatCny(receipt.value)}</span>
        <span className="text-meta text-muted-foreground shrink-0">{STATUS_LABEL[receipt.basis.settlementStatus]}</span>
      </div>

      {/* 怎么算：逐步公式 + 小计,复用折叠模式 */}
      {receipt.steps.length ? (
        <details className="px-3 py-2 border-b border-border">
          <summary className="cursor-pointer select-none text-meta text-muted-foreground hover:text-foreground">计算过程</summary>
          <ol className="mt-1.5 flex flex-col gap-1.5">
            {receipt.steps.map((step, i) => (
              <li key={i} className="text-small">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">{step.label}</span>
                  <span className="shrink-0 tabular-nums">{formatCny(step.subtotal)}</span>
                </div>
                {step.expr ? (
                  <div className="text-caption text-muted-foreground/80 font-mono whitespace-pre-wrap break-all pt-0.5">{step.expr}</div>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {/* 从哪来：原始文件 / 单元格 / 发票号 / 记录数 */}
      {receipt.source.length ? (
        <div className="px-3 py-2 border-b border-border">
          <span className="text-meta text-muted-foreground">数据来源</span>
          <ul className="mt-1 flex flex-col gap-0.5">
            {receipt.source.map((s, i) => (
              <li key={i} className="text-small text-muted-foreground break-all">{formatSource(s)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 按哪版口径：口径版本 + 时点 + 舍入规则 */}
      <div className="px-3 py-2 text-caption text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
        <span>口径版本 {receipt.basis.caliberVersion}</span>
        <span>时点 {receipt.basis.asOf}</span>
        <span>{ROUNDING_LABEL[receipt.rounding]}</span>
      </div>

      {/* 为什么这么处理：不确定点 / 降级措辞 / 合规备注 */}
      {receipt.caveats?.length ? (
        <div className="px-3 py-2 border-t border-[color:var(--tone-notice)]/30 bg-[color:var(--tone-notice)]/12 text-meta flex flex-col gap-1">
          {receipt.caveats.map((c, i) => (
            <span key={i} className="flex items-start gap-2">
              <HugeiconsIcon icon={Alert02Icon} size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>{c}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
