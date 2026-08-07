/** L10 boundary shared by custom file-producing tools. */
export async function withFileMutationQueue<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const { withFileMutationQueue: piQueue } = await import("@earendil-works/pi-coding-agent");
  const ordered = [...new Set(paths.map((filePath) => filePath))].sort();
  const acquire = (index: number): Promise<T> => {
    const filePath = ordered[index];
    if (!filePath) return fn();
    return piQueue(filePath, () => acquire(index + 1));
  };
  return acquire(0);
}
