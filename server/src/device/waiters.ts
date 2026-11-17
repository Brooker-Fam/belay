/**
 * Phones waiting for a new policy (the long-poll, GET /api/v1/policy). In memory: one family
 * per server, one process.
 *
 * A change made in this process wakes the phone's waiters at once (`changed`). Changes made
 * by another process, like the CLI, are noticed by checking the waiting phones' versions in
 * the database every second, so they reach the phone within a second or two as well.
 */
export interface Waiters {
  /** Wakes this phone's waiters whose version is now out of date. */
  changed(deviceId: string): void;
  /**
   * Waits until the phone's version isn't `have` any more (true), or until `ms` pass or the
   * signal aborts (false).
   */
  wait(deviceId: string, have: number, ms: number, signal?: AbortSignal): Promise<boolean>;
  /** Answers every waiting request now (with 204), so the server can stop without holding them. */
  close(): void;
  /** How many requests are waiting, for tests. */
  readonly size: number;
}

interface Waiter {
  have: number;
  finish: (changed: boolean) => void;
}

export function createWaiters(versionOf: (deviceId: string) => number, opts: { pollMs?: number; maxPerPhone?: number } = {}): Waiters {
  const pollMs = opts.pollMs ?? 1000;
  // A phone holds one long-poll; a second one (say, after its connection dropped unnoticed)
  // takes the place of the oldest, which is answered at once.
  const maxPerPhone = opts.maxPerPhone ?? 2;
  const byPhone = new Map<string, Set<Waiter>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = (deviceId: string) => {
    const waiting = byPhone.get(deviceId);
    if (!waiting?.size) return;
    const version = versionOf(deviceId);
    for (const w of [...waiting]) if (w.have !== version) w.finish(true);
  };

  const stopIfIdle = () => {
    if (byPhone.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    changed: check,
    wait(deviceId, have, ms, signal) {
      return new Promise<boolean>((resolve) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        let waiting = byPhone.get(deviceId);
        if (!waiting) {
          waiting = new Set();
          byPhone.set(deviceId, waiting);
        }
        while (waiting.size >= maxPerPhone) {
          const oldest = waiting.values().next();
          if (oldest.done) break;
          oldest.value.finish(false);
        }
        let settled = false;
        const waiter: Waiter = {
          have,
          finish: (changed) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
            const set = byPhone.get(deviceId);
            set?.delete(waiter);
            if (set && set.size === 0) byPhone.delete(deviceId);
            stopIfIdle();
            resolve(changed);
          },
        };
        const onAbort = () => {
          waiter.finish(false);
        };
        const timeout = setTimeout(() => {
          waiter.finish(false);
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting.add(waiter);
        if (timer === null) {
          timer = setInterval(() => {
            for (const id of [...byPhone.keys()]) check(id);
          }, pollMs);
          timer.unref();
        }
      });
    },
    close() {
      for (const set of [...byPhone.values()]) for (const w of [...set]) w.finish(false);
    },
    get size() {
      let n = 0;
      for (const set of byPhone.values()) n += set.size;
      return n;
    },
  };
}
