/**
 * Phase 4: a parent's "Check now" (and MCP's locate_now) waits up to a minute for the fix that
 * answers it. In memory, like the policy long-poll's waiters: a fix stored by this process wakes
 * the phone's waiters at once (`arrived`), and every waiter also looks again each second, so an
 * answer is never missed.
 */
export interface FixWaiters {
  /** A fix arrived from this phone: whoever waits for one looks again. */
  arrived(deviceId: string): void;
  /** Waits until `answered()` is true (true), or until `ms` pass or the signal aborts (false). */
  wait(deviceId: string, answered: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean>;
  /** Ends every wait now (false), so the server can stop without holding them. */
  close(): void;
  /** How many are waiting, for tests. */
  readonly size: number;
}

interface Waiter {
  answered: () => boolean;
  finish: (ok: boolean) => void;
}

export function createFixWaiters(opts: { pollMs?: number } = {}): FixWaiters {
  const pollMs = opts.pollMs ?? 1000;
  const byPhone = new Map<string, Set<Waiter>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const look = (deviceId: string) => {
    for (const w of [...(byPhone.get(deviceId) ?? [])]) if (w.answered()) w.finish(true);
  };
  const stopIfIdle = () => {
    if (byPhone.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    arrived: look,
    wait(deviceId, answered, ms, signal) {
      return new Promise<boolean>((resolve) => {
        if (answered()) {
          resolve(true);
          return;
        }
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        let set = byPhone.get(deviceId);
        if (!set) {
          set = new Set();
          byPhone.set(deviceId, set);
        }
        let settled = false;
        const waiter: Waiter = {
          answered,
          finish: (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
            const mine = byPhone.get(deviceId);
            mine?.delete(waiter);
            if (mine?.size === 0) byPhone.delete(deviceId);
            stopIfIdle();
            resolve(ok);
          },
        };
        const onAbort = () => {
          waiter.finish(false);
        };
        const timeout = setTimeout(() => {
          waiter.finish(answered());
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        set.add(waiter);
        if (timer === null) {
          timer = setInterval(() => {
            for (const id of [...byPhone.keys()]) look(id);
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
