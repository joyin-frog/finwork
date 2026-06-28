// 新会话提示轮换的纯随机挑选逻辑(无 JSX、无依赖,便于单测)。

/**
 * 在 [0,len) 里挑一个随机下标,且不等于 prev(避免连续两次重复同一条)。
 * prev 越界(如初始 -1)时在全集里均匀挑;len<=1 时恒返回 0。
 */
export function pickTipIndex(prev: number, len: number, rnd: number = Math.random()): number {
  if (len <= 1) return 0;
  if (prev < 0 || prev >= len) return Math.floor(rnd * len);
  // 在去掉 prev 的 len-1 个候选里均匀挑,再把落点映射回原下标(跳过 prev)。
  const i = Math.floor(rnd * (len - 1));
  return i >= prev ? i + 1 : i;
}
