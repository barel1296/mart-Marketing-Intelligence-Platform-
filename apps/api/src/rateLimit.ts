import { AppError } from '@mart/shared';

/**
 * In-process fixed-window rate limiter.
 *
 * Deliberately small: enough to blunt credential stuffing and sync-trigger
 * hammering on a single-node Phase 0A deployment, with a clean seam to swap in
 * a shared store when MART runs multiple API replicas.
 */
type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): void {
    const current = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      this.buckets.set(key, { count: 1, resetAt: current + this.windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count > this.limit) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - current) / 1000);
      throw new AppError('rate_limited', 'Too many requests. Try again shortly.', {
        details: { retryAfterSeconds },
      });
    }
  }

  /** Called on success so a valid sign-in does not consume the failure budget. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  /** Drop expired buckets; called periodically so the map cannot grow forever. */
  sweep(): void {
    const current = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= current) this.buckets.delete(key);
    }
  }
}

export const authLimiter = new RateLimiter(10, 5 * 60 * 1000);
export const syncTriggerLimiter = new RateLimiter(30, 60 * 1000);
export const mutationLimiter = new RateLimiter(300, 60 * 1000);

/** Clear all limiter state. Used by tests; never called in production paths. */
export function resetAllLimiters(): void {
  for (const limiter of [authLimiter, syncTriggerLimiter, mutationLimiter]) {
    limiter.clear();
  }
}
