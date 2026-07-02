/**
 * markdown-rehype-config.ts — 共享 rehype 配置
 * 被 chat-page.tsx 与 markdown-message.tsx 共用
 */

import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import type { PluggableList } from "unified";

export const REHYPE_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
  },
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "finance-file"] },
};

export const REHYPE_PLUGINS: PluggableList = [rehypeHighlight, [rehypeSanitize, REHYPE_SANITIZE_SCHEMA]];
