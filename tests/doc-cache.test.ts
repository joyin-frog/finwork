import assert from "node:assert/strict";
import { DocCache } from "../lib/agent/mcp-tools/doc-cache.ts";

export const docCacheTestPromise = (async () => {
  // ── DC1: 同一 key 第二次调用不再触发底层(命中缓存) ──
  {
    let calls = 0;
    const cache = new DocCache(32);
    const backend = async (_p: string) => { calls++; return "text-A"; };

    const r1 = await cache.getOrCompute("/abs/file.pdf", 1000, 512, backend);
    const r2 = await cache.getOrCompute("/abs/file.pdf", 1000, 512, backend);
    assert.equal(r1, "text-A", "DC1a: 首次应返回结果");
    assert.equal(r2, "text-A", "DC1b: 缓存命中应返回相同结果");
    assert.equal(calls, 1, "DC1c: 底层函数应只调用 1 次");
    console.log("doc-cache: DC1 缓存命中 ✓");
  }

  // ── DC2: mtime 变化后重新调用底层 ──
  {
    let calls = 0;
    const cache = new DocCache(32);
    const backend = async (_p: string) => { calls++; return `text-${calls}`; };

    await cache.getOrCompute("/abs/file.pdf", 1000, 512, backend);
    const r2 = await cache.getOrCompute("/abs/file.pdf", 9999 /* mtime changed */, 512, backend);
    assert.equal(calls, 2, "DC2a: mtime 变化应触发底层再次调用");
    assert.equal(r2, "text-2", "DC2b: 应返回新结果");
    console.log("doc-cache: DC2 mtime 变化失效 ✓");
  }

  // ── DC3: size 变化后重新调用底层 ──
  {
    let calls = 0;
    const cache = new DocCache(32);
    const backend = async (_p: string) => { calls++; return `text-${calls}`; };

    await cache.getOrCompute("/abs/file.pdf", 1000, 512, backend);
    await cache.getOrCompute("/abs/file.pdf", 1000, 999 /* size changed */, backend);
    assert.equal(calls, 2, "DC3: size 变化应触发底层再次调用");
    console.log("doc-cache: DC3 size 变化失效 ✓");
  }

  // ── DC4: 报错不缓存 ──
  {
    let calls = 0;
    const cache = new DocCache(32);
    const backend = async (_p: string) => {
      calls++;
      if (calls === 1) throw new Error("OCR failed");
      return "text-ok";
    };

    let threw = false;
    try {
      await cache.getOrCompute("/abs/err.pdf", 1000, 512, backend);
    } catch {
      threw = true;
    }
    assert.ok(threw, "DC4a: 底层抛错时 getOrCompute 应向上抛");
    const r2 = await cache.getOrCompute("/abs/err.pdf", 1000, 512, backend);
    assert.equal(calls, 2, "DC4b: 报错不缓存,第二次应再次调用底层");
    assert.equal(r2, "text-ok", "DC4c: 第二次成功应返回结果");
    console.log("doc-cache: DC4 错误不缓存 ✓");
  }

  // ── DC5: LRU 淘汰(超出上限后最近未使用的条目被驱逐) ──
  {
    const cap = 3;
    const cache = new DocCache(cap);
    const called = new Set<string>();
    const backend = async (p: string) => { called.add(p); return `text-${p}`; };

    // 填满缓存:A B C
    await cache.getOrCompute("/A", 1, 1, backend);
    await cache.getOrCompute("/B", 1, 1, backend);
    await cache.getOrCompute("/C", 1, 1, backend);

    // 访问 A,使 B 成为 LRU
    await cache.getOrCompute("/A", 1, 1, backend);

    // 加入 D,应驱逐 B(最久未使用)
    await cache.getOrCompute("/D", 1, 1, backend);

    // 此时 B 应已被驱逐:再访问 B 应触发底层
    called.clear();
    await cache.getOrCompute("/B", 1, 1, backend);
    assert.ok(called.has("/B"), "DC5: LRU 淘汰后 B 应被重新获取");

    // B 重新加入时,C 是最久未使用的,被驱逐;A 和 D 仍在缓存中
    // 缓存顺序到此处为 [A, D, B](C 已被淘汰)
    called.clear();
    await cache.getOrCompute("/A", 1, 1, backend);
    await cache.getOrCompute("/D", 1, 1, backend);
    assert.ok(!called.has("/A"), "DC5b: A 应仍在缓存");
    assert.ok(!called.has("/D"), "DC5c: D 应仍在缓存");
    console.log("doc-cache: DC5 LRU 淘汰 ✓");
  }

  console.log("doc-cache: all checks passed ✓");
})();
