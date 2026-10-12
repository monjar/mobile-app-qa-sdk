/**
 * Serializes async work per key inside this process (Snitch is single-instance).
 * Used so two requests for the same attachment never append to its partial
 * file at the same time.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Nobody queued behind us: drop the entry so the map doesn't grow forever.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys with work running or queued (for tests). */
  get size(): number {
    return this.tails.size;
  }
}
