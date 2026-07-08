import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

// 起步级 lint 门:对现有代码 0 error 即可作为 CI 门。
// 现有代码库在 SDK 适配层刻意用 any(带 disable)、个别 require/三斜线,这些规则先关;
// 真实 bug 倾向的规则(hooks 依赖、prefer-const、img)保留为 warning 提供信号。
// 后续可逐步收紧(见 plans/006 不再列为门槛项)。
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "src-tauri/**",
      ".claude/**",
      "tests/**",
      "scripts/**",
      "workers/**",
      "*.config.*",
      "next-env.d.ts"
    ]
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/triple-slash-reference": "off",
      "react/no-unescaped-entities": "off",
      "prefer-const": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "@next/next/no-img-element": "warn"
    }
  },
  // ── WP8 Surface 护栏 ──────────────────────────────────────────────────────
  // 增量禁止在 app/** 新增散落外观类（rounded/shadow/border 族）。
  // warn 级：44 个存量文件未收敛，CI 不能红；WP8 全批次完成后升 error。
  // 豁免：components/ui/**（shadcn 原语层）；app/dev/theme/**（调试台展示区）。
  {
    files: ["app/**/*.tsx"],
    ignores: ["app/dev/theme/**"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          // 字符串字面量路径：className="... rounded-* ..." 等
          selector:
            'JSXAttribute[name.name="className"] Literal[value=/\\brounded(?!-\\[var)(\\b|-)|\\bshadow-(?!none|\\[var)|(^|\\s)border(-[0-9])?(\\s|$)/]',
          message:
            "外观类请改用 Surface 原语或语义 token（见 docs/spec/spec-ui-foundation.md）",
        },
        {
          // 模板字符串路径：className={`... rounded-* ...`} 等
          // agent-detail-drawer.tsx:166 正是此写法，必须盖住。
          selector:
            'JSXAttribute[name.name="className"] TemplateElement[value.raw=/\\brounded(?!-\\[var)(\\b|-)|\\bshadow-(?!none|\\[var)|(^|\\s)border(-[0-9])?(\\s|$)/]',
          message:
            "外观类请改用 Surface 原语或语义 token（见 docs/spec/spec-ui-foundation.md）",
        },
      ],
    },
  },
];

export default config;
