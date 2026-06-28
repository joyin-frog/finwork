import type { KnowledgeCategory } from "./types";

const RULES: Array<{ pattern: RegExp; category: KnowledgeCategory }> = [
  { pattern: /报销|差旅|出差|reimbursement|expense/i,           category: "expense_policy" },
  { pattern: /合同|协议|contract|agreement/i,                   category: "contract" },
  { pattern: /税|tax|增值税|发票|纳税|vat/i,                    category: "tax" },
  { pattern: /财务|会计|规范|制度|准则|流程|finance|accounting|spec|policy/i, category: "finance_spec" },
];

export function inferCategory(filename: string): KnowledgeCategory {
  return inferCategoryFromDocument({ fileName: filename });
}

export function inferCategoryFromDocument(input: {
  fileName?: string;
  title?: string;
  text?: string;
}): KnowledgeCategory {
  const combined = [input.title, input.fileName, input.text?.slice(0, 4000)]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");

  for (const { pattern, category } of RULES) {
    if (pattern.test(combined)) return category;
  }

  return "general";
}
