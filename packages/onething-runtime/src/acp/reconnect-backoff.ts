/**
 * 崩溃后自动重连的退避(A5,方案 `docs/design/acp-integration-2026-09.md` §3.7)。
 *
 * agent 进程意外没了(崩了、被杀、握手没过)之后,下一次有人要用它(发消息、开选项面板)就自动
 * 重连 —— 这是 A0-1 起就有的行为,但从前没有上限:一台起来就崩的 agent 会被每一条消息重新拉起一次。
 * 这里给它一个窗:**30s 内至多重连 3 次**,第 4 次被拒并**锁上**,之后自动重连一律拒,直到用户
 * 手动连(Agent 页「重新连接」/ 连接 / 刷新)才清。
 *
 * 纯的:时钟由构造者递(单测递假钟),不起定时器 —— 窗的过期在下一次问的时候按时刻算。
 * 它只管「这一次放不放」,不认识进程、不认识连接;哪一次算「崩后重连」由 `ACPClient` 判。
 */
import type { AcpReconnectBackoff } from './types.js'

export const ACP_RECONNECT_WINDOW_MS = 30_000
export const ACP_RECONNECT_MAX_ATTEMPTS = 3

export class AcpReconnectBackoffGate {
  /** 窗内每一次放行的时刻,旧的在前。 */
  private attempts: number[] = []
  private latched = false

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = ACP_RECONNECT_WINDOW_MS,
    private readonly maxAttempts: number = ACP_RECONNECT_MAX_ATTEMPTS,
  ) {}

  /**
   * 一次崩后自动重连要起了:窗内还有额度 → 记一笔、答 true;没有 → 锁上、答 false。
   * 锁着的时候一律 false(锁不随窗过期 —— 连着崩了四次的 agent,等半分钟再拉起来多半还是崩)。
   */
  admit(): boolean {
    if (this.latched) return false
    this.prune()
    if (this.attempts.length >= this.maxAttempts) {
      this.latched = true
      return false
    }
    this.attempts.push(this.now())
    return true
  }

  /** 用户手动连:锁与窗一起清。 */
  reset(): void {
    this.attempts = []
    this.latched = false
  }

  get isLatched(): boolean {
    return this.latched
  }

  /** 窗内重连过几次(过期的不算)。 */
  get attemptCount(): number {
    this.prune()
    return this.attempts.length
  }

  get windowSeconds(): number {
    return Math.round(this.windowMs / 1000)
  }

  /** 投影给状态的那一格;没重连过也没锁 = undefined(状态上整格缺席)。 */
  snapshot(): AcpReconnectBackoff | undefined {
    this.prune()
    if (!this.latched && this.attempts.length === 0) return undefined
    return {
      attempts: this.attempts.length,
      ...(!this.latched && this.attempts.length > 0 ? { until: this.attempts[0]! + this.windowMs } : {}),
      latched: this.latched,
    }
  }

  private prune(): void {
    const floor = this.now() - this.windowMs
    while (this.attempts.length > 0 && this.attempts[0]! <= floor) this.attempts.shift()
  }
}

/** 锁上之后自动重连被拒时交给这一轮的那句话(落进助手消息的 `errorDetails`)。 */
export function acpReconnectRefusal(agentName: string, attempts: number, windowSeconds: number, lastError?: string): Error {
  const why = lastError ? ` Last error: ${lastError}` : ''
  return new Error(
    `ACP agent "${agentName}" crashed and was restarted ${attempts} times within ${windowSeconds}s; `
    + `automatic reconnect is paused. Use "Reconnect" on the Agents page to try again.${why}`,
  )
}
