/**
 * surface-variants.test.ts
 * 锁定 Surface 组件 cva 变体 → class 映射。
 * 先红（components/ui/surface.tsx 不存在）→ 实现后绿。
 */

import assert from "node:assert/strict";

export const surfaceVariantsTestPromise = (async () => {
  // Try to import the surface module – if missing the test fails here (red state).
  let mod: { surfaceVariants: (opts: Record<string, unknown>) => string };
  try {
    mod = await import("../../components/ui/surface.js");
  } catch {
    throw new Error(
      "surface-variants RED: components/ui/surface.tsx does not exist yet. " +
      "Implement it to make this test green."
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { surfaceVariants } = mod as any;

  assert.ok(typeof surfaceVariants === "function", "surfaceVariants must be exported as a function");

  // ── level variants ──────────────────────────────────────────────────────────

  // level=page: background color token class
  assert.ok(
    surfaceVariants({ level: "page" }).includes("bg-background"),
    "level=page should produce bg-background"
  );

  // level=card: bg-card + elevation-1 shadow
  {
    const cls = surfaceVariants({ level: "card" });
    assert.ok(cls.includes("bg-card"), "level=card should produce bg-card");
    assert.ok(
      cls.includes("shadow-[var(--elevation-1)]"),
      "level=card should produce shadow-[var(--elevation-1)]"
    );
  }

  // level=overlay: bg-popover + elevation-3 shadow
  {
    const cls = surfaceVariants({ level: "overlay" });
    assert.ok(cls.includes("bg-popover"), "level=overlay should produce bg-popover");
    assert.ok(
      cls.includes("shadow-[var(--elevation-3)]"),
      "level=overlay should produce shadow-[var(--elevation-3)]"
    );
  }

  // level=panel: bg-card + elevation-1 shadow (same as card, intentional)
  {
    const cls = surfaceVariants({ level: "panel" });
    assert.ok(cls.includes("bg-card"), "level=panel should produce bg-card");
    assert.ok(
      cls.includes("shadow-[var(--elevation-1)]"),
      "level=panel should produce shadow-[var(--elevation-1)]"
    );
  }

  // ── edge variants ───────────────────────────────────────────────────────────

  // edge=none: no border classes
  assert.ok(
    !surfaceVariants({ edge: "none" }).match(/\bborder\b/),
    "edge=none should not produce any border class"
  );

  // edge=hairline: border border-border
  {
    const cls = surfaceVariants({ edge: "hairline" });
    assert.ok(cls.includes("border-border"), "edge=hairline should produce border-border");
  }

  // edge=strong: border-2 border-border
  {
    const cls = surfaceVariants({ edge: "strong" });
    assert.ok(cls.includes("border-2"), "edge=strong should produce border-2");
    assert.ok(cls.includes("border-border"), "edge=strong should produce border-border");
  }

  // ── shape variants ──────────────────────────────────────────────────────────

  // shape=chip → rounded-[var(--radius-chip)]
  assert.ok(
    surfaceVariants({ shape: "chip" }).includes("rounded-[var(--radius-chip)]"),
    "shape=chip should produce rounded-[var(--radius-chip)]"
  );

  // shape=control → rounded-md
  assert.ok(
    surfaceVariants({ shape: "control" }).includes("rounded-md"),
    "shape=control should produce rounded-md"
  );

  // shape=card → rounded-lg
  assert.ok(
    surfaceVariants({ shape: "card" }).includes("rounded-lg"),
    "shape=card should produce rounded-lg"
  );

  // shape=panel → rounded-xl
  assert.ok(
    surfaceVariants({ shape: "panel" }).includes("rounded-xl"),
    "shape=panel should produce rounded-xl"
  );

  // shape=overlay → rounded-2xl
  assert.ok(
    surfaceVariants({ shape: "overlay" }).includes("rounded-2xl"),
    "shape=overlay should produce rounded-2xl"
  );

  // shape=pill → rounded-full
  assert.ok(
    surfaceVariants({ shape: "pill" }).includes("rounded-full"),
    "shape=pill should produce rounded-full"
  );

  // shape=none → no rounded class
  assert.ok(
    !surfaceVariants({ shape: "none" }).match(/\brounded/),
    "shape=none should not produce any rounded class"
  );

  // ── inset variant ────────────────────────────────────────────────────────────

  // inset=true: shadow-[var(--elevation-inset)]
  {
    const cls = surfaceVariants({ inset: true });
    assert.ok(
      cls.includes("shadow-[var(--elevation-inset)]"),
      "inset=true should produce shadow-[var(--elevation-inset)]"
    );
  }

  // ── default combination ─────────────────────────────────────────────────────
  // Default: level=card, edge=hairline, shape=card
  {
    const cls = surfaceVariants({});
    assert.ok(cls.includes("bg-card"), "default should produce bg-card");
    assert.ok(cls.includes("border-border"), "default should produce border-border");
    assert.ok(cls.includes("rounded-lg"), "default should produce rounded-lg");
  }

  console.log("✓ surface-variants: all assertions passed (incl. level=panel, edge=strong, inset=true)");
})();
