export class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly limit: number) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryRun = () => {
        if (this.running < this.limit) {
          this.running++;
          resolve(() => {
            this.running--;
            if (this.queue.length > 0) this.queue.shift()!();
          });
        } else {
          this.queue.push(tryRun);
        }
      };
      tryRun();
    });
  }
}
