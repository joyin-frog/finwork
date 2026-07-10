import { z } from "zod/v4";

/**
 * 安全地尝试 JSON.parse。
 * 解析失败必须原样返回该字符串，让原 schema 报它自己的类型错误；
 * 绝不吞异常、绝不返回 undefined/null。
 */
function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * 宽松化垫片：当字段收到 JSON 字符串时先尝试解析，再交给原 zod 校验。
 * 已是对象/数组/数字等一律原样透传，零副作用。
 *
 * 用途：防御 MCP 工具参数整体被模型发成 JSON 字符串（如 entries 发成
 * "[{...}]" 而非 [{...}]）。仅纯防御，不改任何业务逻辑。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jsonCoercible<T extends z.ZodType<any, any>>(schema: T) {
  return z.preprocess((v) => (typeof v === "string" ? tryParseJson(v) : v), schema);
}
