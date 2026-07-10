import assert from "node:assert/strict";
import { z } from "zod/v4";
import { jsonCoercible } from "../lib/agent/mcp-tools/coerce-json.ts";

// TDD for jsonCoercible helper (AR3b):
// 防御性垫片：MCP 工具参数整体被模型发成 JSON 字符串时自动 parse，其余原样透传。
export const coerceJsonTestPromise = (async () => {
  // ① string JSON array → 解析成数组，通过内层校验
  {
    const schema = jsonCoercible(z.array(z.string()));
    const result = schema.safeParse('["a","b","c"]');
    assert.ok(result.success, '① FAIL: string JSON array 应解析成功');
    assert.deepEqual(result.data, ["a", "b", "c"], '① FAIL: 数组内容不符');
  }

  // ② string JSON object → 解析成对象
  {
    const schema = jsonCoercible(z.object({ code: z.string(), amount: z.number() }));
    const result = schema.safeParse('{"code":"1002","amount":100}');
    assert.ok(result.success, '② FAIL: string JSON object 应解析成功');
    assert.deepEqual(result.data, { code: "1002", amount: 100 }, '② FAIL: 对象内容不符');
  }

  // ③ 已是对象/数组 → 原样通过，零副作用
  {
    const arrSchema = jsonCoercible(z.array(z.number()));
    const arrInput = [1, 2, 3];
    const arrResult = arrSchema.safeParse(arrInput);
    assert.ok(arrResult.success, '③ FAIL: 真实数组应原样通过');
    assert.deepEqual(arrResult.data, arrInput, '③ FAIL: 数组不应被修改');
  }
  {
    const objSchema = jsonCoercible(z.object({ x: z.number() }));
    const objInput = { x: 42 };
    const objResult = objSchema.safeParse(objInput);
    assert.ok(objResult.success, '③ FAIL: 真实对象应原样通过');
    assert.deepEqual(objResult.data, objInput, '③ FAIL: 对象不应被修改');
  }

  // ④ 非法 JSON 字符串 → 原样保留，由内层 schema 报类型错，不崩溃
  {
    const schema = jsonCoercible(z.array(z.string()));
    let threw = false;
    let result: ReturnType<typeof schema.safeParse> | undefined;
    try {
      result = schema.safeParse("not valid json [[[");
    } catch {
      threw = true;
    }
    assert.ok(!threw, '④ FAIL: 非法 JSON 不应抛出异常（tryParseJson 原样返回字符串）');
    assert.ok(result !== undefined && !result.success, '④ FAIL: 非法 JSON 字符串应由内层 schema 校验失败');
    assert.ok(result !== undefined && result.error.issues.length > 0, '④ FAIL: 应有类型校验错误');
  }

  // ⑤ 数字/null → 不动，由内层 schema 正常处理
  {
    const arrSchema = jsonCoercible(z.array(z.string()));

    // 数字不是字符串，透传 → 内层 array schema 拒绝
    const numResult = arrSchema.safeParse(42);
    assert.ok(!numResult.success, '⑤ FAIL: 数字应被 array schema 拒绝（未被修改）');

    // null 透传 → 内层非可选 array schema 拒绝
    const nullResult = arrSchema.safeParse(null);
    assert.ok(!nullResult.success, '⑤ FAIL: null 应被非可选 array schema 拒绝');

    // 数字传入 number schema → 原样通过
    const numSchema = jsonCoercible(z.number());
    const numPassResult = numSchema.safeParse(42);
    assert.ok(numPassResult.success, '⑤ FAIL: 数字传入 number schema 应通过');
    assert.equal(numPassResult.data, 42, '⑤ FAIL: 数字值不应被修改');
  }

  console.log("coerce-json: all 5 checks passed ✓");
})();
