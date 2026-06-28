import assert from "node:assert/strict";
import { pickTipIndex } from "../app/chat/tip-picker.ts";

function main() {
  // 单条 / 空池:恒返回 0
  assert.equal(pickTipIndex(-1, 1), 0);
  assert.equal(pickTipIndex(0, 1), 0);
  assert.equal(pickTipIndex(3, 0), 0);
  console.log("✓ PASS: 单条/空池恒返回 0");

  // 初始未选(prev=-1)在全集均匀,可取到首条和末条
  assert.equal(pickTipIndex(-1, 5, 0), 0);
  assert.equal(pickTipIndex(-1, 5, 0.999), 4);
  console.log("✓ PASS: 初始未选时覆盖全集(含首/末)");

  // 跳过 prev 的映射:prev=2 时候选为 [0,1,3,4]
  assert.equal(pickTipIndex(2, 5, 0), 0);     // i=0 <2 → 0
  assert.equal(pickTipIndex(2, 5, 0.4), 1);   // i=floor(0.4*4)=1 <2 → 1
  assert.equal(pickTipIndex(2, 5, 0.5), 3);   // i=floor(0.5*4)=2 >=2 → 3
  assert.equal(pickTipIndex(2, 5, 0.999), 4); // i=3 >=2 → 4
  console.log("✓ PASS: 跳过 prev 的下标映射正确");

  // 不变量:大量随机抽样,结果永不等于 prev 且不越界
  for (let len = 2; len <= 12; len++) {
    for (let prev = 0; prev < len; prev++) {
      for (let k = 0; k < 1000; k++) {
        const idx = pickTipIndex(prev, len, Math.random());
        assert.ok(idx >= 0 && idx < len, `下标越界 idx=${idx} len=${len}`);
        assert.notEqual(idx, prev, `不应连续重复 prev=${prev} len=${len}`);
      }
    }
  }
  console.log("✓ PASS: 随机抽样下不重复上一条 + 下标不越界");

  console.log("composer-tips: ALL PASS");
}

main();
