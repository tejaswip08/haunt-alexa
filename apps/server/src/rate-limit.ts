/**
 * A small in-memory sliding-window limiter, per client key (IP address). It protects paid
 * APIs from accidental loops and casual abuse on a single server; a multi-instance
 * deployment would need a shared store or a WAF rule instead.
 */
export interface RateLimiter {
  /** Records one request. Returns how long to wait, in seconds, when over the limit. */
  hit(key: string, now?: number): { ok: true } | { ok: false; retryAfterSeconds: number };
}

export function createRateLimiter(rules: { windowMs: number; max: number }[]): RateLimiter {
  const hits = new Map<string, number[]>();
  const longest = Math.max(...rules.map((rule) => rule.windowMs));
  return {
    hit(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((at) => now - at < longest);
      for (const rule of rules) {
        const inWindow = recent.filter((at) => now - at < rule.windowMs);
        if (inWindow.length >= rule.max) {
          const retryAfterSeconds = Math.max(1, Math.ceil((inWindow[0]! + rule.windowMs - now) / 1000));
          hits.set(key, recent);
          return { ok: false, retryAfterSeconds };
        }
      }
      recent.push(now);
      hits.set(key, recent);
      // Forget idle clients so the map can't grow without bound.
      if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((at) => now - at < longest)) hits.delete(k);
      return { ok: true };
    },
  };
}
