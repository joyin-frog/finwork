import type { FormulaAst } from "./contracts";

const REF_PATTERN = /(?:(?:'([^']+)'|([A-Za-z0-9_ .-]+))!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)/g;

function splitArguments(source: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') quote = !quote;
    if (quote) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      values.push(source.slice(start, index));
      start = index + 1;
    }
  }
  values.push(source.slice(start));
  return values.map((item) => item.trim()).filter(Boolean);
}

export function formulaReferences(formula: string, currentSheet: string): string[] {
  const references = new Set<string>();
  for (const match of formula.matchAll(REF_PATTERN)) {
    const sheet = (match[1] ?? match[2] ?? currentSheet).trim();
    references.add(`${sheet}!${match[3].replaceAll("$", "").toUpperCase()}`);
  }
  return [...references];
}

export function parseFormulaAst(formula: string, currentSheet: string): FormulaAst {
  const source = formula.trim().replace(/^=/, "");
  const functionMatch = source.match(/^([A-Za-z][A-Za-z0-9_.]*)\((.*)\)$/s);
  if (functionMatch) {
    return { kind: "function", name: functionMatch[1].toUpperCase(), args: splitArguments(functionMatch[2]).map((item) => parseFormulaAst(item, currentSheet)) };
  }
  const exactRef = [...source.matchAll(REF_PATTERN)];
  if (exactRef.length === 1 && exactRef[0][0] === source) {
    return { kind: "reference", sheet: (exactRef[0][1] ?? exactRef[0][2] ?? currentSheet).trim(), range: exactRef[0][3].replaceAll("$", "").toUpperCase() };
  }
  const operator = source.match(/^(.*?)([+\-*/^])(.*)$/s);
  if (operator && operator[1].trim() && operator[3].trim()) {
    return { kind: "expression", operator: operator[2], operands: [parseFormulaAst(operator[1], currentSheet), parseFormulaAst(operator[3], currentSheet)] };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(source)) return { kind: "literal", value: Number(source) };
  if (/^".*"$/.test(source)) return { kind: "literal", value: source.slice(1, -1) };
  return { kind: "opaque", source };
}
