/**
 * eslint-appearance-guard.test.ts
 * 验证 ESLint 护栏六路径行为（no-restricted-syntax 规则）。
 * 先红（规则未加进 eslint.config.mjs）→ 实现后绿。
 *
 * 路径：
 * ① app/** 字符串字面量 className 含 rounded-* 触发
 * ② 裸 rounded 触发
 * ③ 模板字符串 className={`rounded ...`} 触发
 * ④ shadow-md 触发而 shadow-[var(--elevation-1)] 不触发
 * ⑤ 裸 border/border-2 触发而 border-t/border-border 不触发
 * ⑥ components/ui/** 豁免；app/dev/theme/** 豁免
 *
 * 核心约束（B2 修复）：
 *   测试从真实 eslint.config.mjs 动态 import 配置，找到
 *   含 no-restricted-syntax 且 files 覆盖 app/**\/*.tsx 的块，
 *   用该块的 rules 跑 Linter——删规则或改坏正则时测试必红。
 */

import assert from "node:assert/strict";
import { Linter } from "eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── helpers ──────────────────────────────────────────────────────────────────

type LintResult = ReturnType<Linter["verify"]>;

/**
 * Lint a JSX snippet simulating a file at `filePath`.
 * Uses the provided rules object.
 * `blockIgnores` controls which filePaths are excluded.
 */
function lintWith(
  code: string,
  filePath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rules: Record<string, any>,
  blockFiles: string[],
  blockIgnores: string[]
): LintResult {
  const linter = new Linter({ configType: "flat" });

  const config = [
    {
      files: blockFiles,
      ignores: blockIgnores,
      rules,
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: "module" as const,
        parserOptions: {
          ecmaFeatures: { jsx: true },
        },
      },
    },
  ];

  return linter.verify(code, config, { filename: filePath });
}

function hasGuardWarning(messages: LintResult): boolean {
  return messages.some(
    (m) =>
      m.ruleId === "no-restricted-syntax" &&
      m.message.includes("Surface 原语")
  );
}

// ── test body ─────────────────────────────────────────────────────────────────

export const eslintAppearanceGuardTestPromise = (async () => {
  // ── Load and validate the real eslint.config.mjs ─────────────────────────
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const eslintConfigPath = path.resolve(__dirname, "../../eslint.config.mjs");

  // Dynamic import of the real eslint.config.mjs (default export is a flat config array)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eslintConfigModule = await import(eslintConfigPath) as { default: any[] };
  const flatConfigArray: unknown[] = eslintConfigModule.default;

  assert.ok(
    Array.isArray(flatConfigArray),
    "eslint.config.mjs must export an array (flat config)"
  );

  // Find the config block that:
  //   1. Has files covering app/**/*.tsx
  //   2. Has rules.no-restricted-syntax
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guardBlock = (flatConfigArray as any[]).find((block: any) => {
    if (!block || typeof block !== "object") return false;
    const files: unknown = block.files;
    if (!Array.isArray(files)) return false;
    const coversAppTsx = (files as string[]).some(
      (f) => typeof f === "string" && f.includes("app/**") && f.includes(".tsx")
    );
    if (!coversAppTsx) return false;
    return (
      block.rules &&
      typeof block.rules === "object" &&
      "no-restricted-syntax" in block.rules
    );
  });

  assert.ok(
    guardBlock !== undefined,
    "eslint.config.mjs must contain a config block with files covering app/**/*.tsx and rules.no-restricted-syntax — delete or comment-out the block and this assertion fails"
  );

  // Verify two selector entries (Literal + TemplateElement) are present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noRestrictedSyntaxConfig: unknown[] = guardBlock.rules["no-restricted-syntax"];
  assert.ok(
    Array.isArray(noRestrictedSyntaxConfig),
    "no-restricted-syntax rule config must be an array"
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectorEntries = (noRestrictedSyntaxConfig as any[]).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => e && typeof e === "object" && e.selector
  );
  assert.ok(
    selectorEntries.length >= 2,
    `no-restricted-syntax must have at least 2 selector entries (Literal + TemplateElement), got ${selectorEntries.length}`
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasLiteralSelector = selectorEntries.some((e: any) => String(e.selector).includes("Literal"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasTemplateSelector = selectorEntries.some((e: any) => String(e.selector).includes("TemplateElement"));
  assert.ok(hasLiteralSelector, "no-restricted-syntax must have a selector mentioning Literal");
  assert.ok(hasTemplateSelector, "no-restricted-syntax must have a selector mentioning TemplateElement");

  // Capture files and ignores from the real block
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blockFiles: string[] = Array.isArray((guardBlock as any).files)
    ? (guardBlock as any).files as string[]
    : ["app/**/*.tsx"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blockIgnores: string[] = Array.isArray((guardBlock as any).ignores)
    ? (guardBlock as any).ignores as string[]
    : [];

  // Helper that uses the real rules + files + ignores from eslint.config.mjs
  function lint(code: string, filePath: string): LintResult {
    return lintWith(code, filePath, guardBlock.rules, blockFiles, blockIgnores);
  }

  // ── 11 path assertions ────────────────────────────────────────────────────

  // ① rounded-* string literal in app/**
  {
    const code = `export function C() { return <div className="flex rounded-lg p-2" />; }`;
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      hasGuardWarning(msgs),
      "① rounded-lg in string literal under app/** should trigger guard"
    );
  }

  // ② bare rounded string literal
  {
    const code = `export function C() { return <div className="rounded" />; }`;
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      hasGuardWarning(msgs),
      "② bare rounded in string literal should trigger guard"
    );
  }

  // ③ template string with rounded
  {
    const code = "export function C() { return <div className={`flex rounded-md`} />; }";
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      hasGuardWarning(msgs),
      "③ rounded-md in template string should trigger guard"
    );
  }

  // ④a shadow-md triggers
  {
    const code = `export function C() { return <div className="shadow-md p-2" />; }`;
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      hasGuardWarning(msgs),
      "④a shadow-md should trigger guard"
    );
  }

  // ④b shadow-[var(--elevation-1)] does NOT trigger
  {
    const code = `export function C() { return <div className="shadow-[var(--elevation-1)]" />; }`;
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      !hasGuardWarning(msgs),
      "④b shadow-[var(--elevation-1)] should NOT trigger guard"
    );
  }

  // ⑤a bare border triggers
  {
    const code = `export function C() { return <div className="border p-2" />; }`;
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      hasGuardWarning(msgs),
      "⑤a bare border should trigger guard"
    );
  }

  // ⑤b border-2 triggers
  {
    const code = `export function C() { return <div className="border-2" />; }`;
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      hasGuardWarning(msgs),
      "⑤b border-2 should trigger guard"
    );
  }

  // ⑤c border-t does NOT trigger
  {
    const code = `export function C() { return <div className="border-t p-2" />; }`;
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      !hasGuardWarning(msgs),
      "⑤c border-t should NOT trigger guard"
    );
  }

  // ⑤d border-border does NOT trigger
  {
    const code = `export function C() { return <div className="border-border" />; }`;
    const msgs = lint(code, "app/components/foo.tsx");
    assert.ok(
      !hasGuardWarning(msgs),
      "⑤d border-border should NOT trigger guard"
    );
  }

  // ⑥a components/ui/** exempt
  {
    const code = `export function C() { return <div className="rounded-lg border shadow-md" />; }`;
    const msgs = lint(code, "components/ui/button.tsx");
    assert.ok(
      !hasGuardWarning(msgs),
      "⑥a components/ui/** should be exempt from guard"
    );
  }

  // ⑥b app/dev/theme/** exempt
  {
    const code = `export function C() { return <div className="rounded-lg border shadow-md" />; }`;
    const msgs = lint(code, "app/dev/theme/theme-playground.tsx");
    assert.ok(
      !hasGuardWarning(msgs),
      "⑥b app/dev/theme/** should be exempt from guard"
    );
  }

  console.log("✓ eslint-appearance-guard: all 11 path assertions passed (using real eslint.config.mjs rules)");
})();
