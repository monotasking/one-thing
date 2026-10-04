export interface RateLimiterConfig {
  maxPerMinute: number
}

const WINDOW_MS = 60 * 1000

export class RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(private readonly config: RateLimiterConfig) {}

  check(userId: string, now = Date.now()): boolean {
    const cutoff = now - WINDOW_MS
    const timestamps = (this.hits.get(userId) ?? []).filter(timestamp => timestamp > cutoff)

    if (timestamps.length >= this.config.maxPerMinute) {
      this.hits.set(userId, timestamps)
      return false
    }

    timestamps.push(now)
    this.hits.set(userId, timestamps)
    return true
  }
}
