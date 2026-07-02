"use client";

// 团队面板冷启动引导卡（CV-3 §5.3）
// 仅当 team.length === 0 时在右列显示。
// 按钮派发 CustomEvent("chat-float:open") 打开浮窗（派活入口已退役）。

export function TeamGrowthHint() {
  function openChatFloat() {
    window.dispatchEvent(new CustomEvent("chat-float:open", { detail: {} }));
  }

  return (
    <section className="rounded-lg border border-dashed border-border bg-card/50 px-4 py-5 flex flex-col items-center gap-3 text-center">
      <p className="text-body text-muted-foreground">
        把活派给我，你的财务团队会在这里长出来
      </p>
      <button
        type="button"
        onClick={openChatFloat}
        className="text-meta text-muted-foreground hover:text-foreground border border-border rounded px-3 py-1 transition-colors"
      >
        先派一个活
      </button>
    </section>
  );
}
