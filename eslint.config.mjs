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
  }
];

export default config;
