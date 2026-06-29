import assert from "node:assert/strict";
import { Semaphore } from "../lib/utils/semaphore.ts";

// 让已就绪的 microtask 全部 flush(release 唤醒 waiter 是异步 resolve)。
const flush = () => new Promise((r) => setTimeout(r, 0));

export const semaphoreTestPromise = (async () => {
  // ── 1. limit 以内 acquire 立即 resolve ───────────────────────────────
  {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    assert.equal(typeof r1, "function", "acquire 应返回 release 函数");
    assert.equal(typeof r2, "function", "第二个 acquire 在 limit 内应立即返回");
    r1();
    r2();
  }

  // ── 2. 超出 limit 的 acquire 阻塞,直到有人 release ────────────────────
  {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    await s.acquire(); // 占满 2 个槽位

    let third = false;
    const p3 = s.acquire().then((rel) => {
      third = true;
      return rel;
    });

    await flush();
    assert.equal(third, false, "第三个 acquire 在满载时应阻塞");

    r1(); // 释放一个槽位
    const r3 = await p3;
    assert.equal(third, true, "release 后阻塞的 acquire 应被唤醒");
    r3();
  }

  // ── 3. 唤醒顺序为 FIFO ───────────────────────────────────────────────
  {
    const s = new Semaphore(1);
    const r1 = await s.acquire(); // 占住唯一槽位

    const order: number[] = [];
    const pA = s.acquire().then((rel) => {
      order.push(1);
      return rel;
    });
    const pB = s.acquire().then((rel) => {
      order.push(2);
      return rel;
    });

    await flush();
    assert.deepEqual(order, [], "两个 waiter 在槽位被占时都应等待");

    r1();
    const relA = await pA;
    relA();
    const relB = await pB;
    relB();
    assert.deepEqual(order, [1, 2], "唤醒顺序应为先进先出");
  }

  // ── 4. limit=1 表现为互斥锁(串行化) ─────────────────────────────────
  {
    const s = new Semaphore(1);
    let active = 0;
    let overlap = false;

    const task = async () => {
      const rel = await s.acquire();
      active++;
      if (active > 1) overlap = true;
      await flush();
      active--;
      rel();
    };

    await Promise.all([task(), task(), task()]);
    assert.equal(overlap, false, "limit=1 时任意时刻只允许一个持有者");
  }

  // ── 5. 高并发下实际并发数永不超过 limit ──────────────────────────────
  {
    const limit = 3;
    const s = new Semaphore(limit);
    let active = 0;
    let peak = 0;

    const task = async () => {
      const rel = await s.acquire();
      active++;
      peak = Math.max(peak, active);
      await flush();
      active--;
      rel();
    };

    await Promise.all(Array.from({ length: 20 }, () => task()));
    assert.ok(peak <= limit, `峰值并发 ${peak} 不应超过 limit ${limit}`);
    assert.ok(peak >= 1, "应至少跑过一个任务");
  }

  console.log("semaphore: all 5 checks passed ✓");
})();
