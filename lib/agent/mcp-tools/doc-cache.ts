/**
 * doc-cache.ts — 进程内 LRU 缓存，供 read_document 使用。
 * Key = (绝对路径, mtimeMs, size)；只缓存成功结果；上限默认 32 条。
 */

export class DocCache {
  private readonly cap: number;
  /** 有序 Map：插入/访问后移到末尾；头部是最久未使用的 */
  private readonly map: Map<string, string>;

  constructor(capacity = 32) {
    this.cap = capacity;
    this.map = new Map();
  }

  private static makeKey(filePath: string, mtimeMs: number, size: number): string {
    return `${filePath}\0${mtimeMs}\0${size}`;
  }

  /**
   * 若缓存命中直接返回；否则调用 backend，成功则写入缓存，失败向上抛（不缓存）。
   */
  async getOrCompute(
    filePath: string,
    mtimeMs: number,
    size: number,
    backend: (filePath: string) => Promise<string>
  ): Promise<string> {
    const key = DocCache.makeKey(filePath, mtimeMs, size);

    if (this.map.has(key)) {
      // 更新 LRU 顺序：删除再重新插入到末尾
      const cached = this.map.get(key)!;
      this.map.delete(key);
      this.map.set(key, cached);
      return cached;
    }

    // 调用底层；抛错则不写缓存
    const result = await backend(filePath);

    // 淘汰最旧条目（Map 迭代顺序 = 插入顺序，第一个 = LRU）
    if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }

    this.map.set(key, result);
    return result;
  }
}
