/** Counting semaphore: at most `max` holders at once, FIFO hand-off to waiters. */
export class Semaphore {
  private free: number;
  private readonly capacity: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.capacity = Math.max(1, max);
    this.free = this.capacity;
  }

  /** True when nobody holds a permit and nobody is waiting. */
  get idle(): boolean {
    return this.waiters.length === 0 && this.free === this.capacity;
  }

  /** Resolves with a release function (safe to call more than once). */
  async acquire(): Promise<() => void> {
    if (this.free > 0) {
      this.free--;
    } else {
      // the permit is handed over directly by release(), `free` stays decremented
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    };
  }
}
