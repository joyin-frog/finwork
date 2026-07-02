"use client";

// 团队面板冷启动引导卡（CV-3 §5.3）
// 仅当 team.length === 0 时在右列显示。
// 按钮聚焦派活入口（dispatch-input），不新增硬编码 prompt。

export function TeamGrowthHint() {
  function focusDispatchInput() {
    // dispatch-input 的 input 元素有 id="dispatch-input-field"
    const el = document.getElementById("dispatch-input-field");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      (el as HTMLInputElement).focus();
    }
  }

  return (
    <section className="rounded-lg border border-dashed border-border bg-card/50 px-4 py-5 flex flex-col items-center gap-3 text-center">
      <p className="text-body text-muted-foreground">
        把活派给我，你的财务团队会在这里长出来
      </p>
      <button
        type="button"
        onClick={focusDispatchInput}
        className="text-meta text-muted-foreground hover:text-foreground border border-border rounded px-3 py-1 transition-colors"
      >
        先派一个活
      </button>
    </section>
  );
}
