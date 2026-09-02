import type { OAuthStartResponse, OAuthStatusResponse } from '@shared/ipc/oauth'

/**
 * 订阅登录流。**流形由后端的答案定,不由名册上的 `oauthFlow` 定** ——
 * 这一条是照着 Vue 壳 `useProviderAuth.ts:91-136` 抄的,而它那么写是有道理的:
 * `OAuthStartResponse` 上确实有一个 `flowKind` 字段,但真正决定「这一屏画什么」
 * 的是**后端这一次到底给没给那几样东西**。给了设备码就画设备码;`flowKind` 说
 * 是设备码而 `userCode` 没给,画出来也是一个空框。
 *
 * 三种流,判据按顺序取第一条命中的:
 *  ① `userCode` + `verificationUri` → **设备码流**:大字码 + 验证网址 + 轮询等待。
 *  ② `requiresCodeEntry`            → **贴码流**:开浏览器授权,把码粘回来。
 *  ③ 其余                            → **浏览器回调流**:开浏览器,这边轮询登录态。
 */
export type OAuthFlowKind = 'device' | 'paste' | 'browser'

/** 设备码轮询:60 次 × 5s。与 Vue 壳 `useProviderAuth.ts:167` / `:166` 同值。 */
export const DEVICE_POLL_MAX_ATTEMPTS = 60
export const DEVICE_POLL_INTERVAL_MS = 5000
/** 服务商喊慢一点就加 5s(`:187`)。 */
export const DEVICE_POLL_SLOW_DOWN_MS = 5000

/** 浏览器回调流:2s 一问,最多 5 分钟(`:212` / `:214`)。 */
export const BROWSER_POLL_INTERVAL_MS = 2000
export const BROWSER_POLL_TIMEOUT_MS = 5 * 60 * 1000

/** 设备码流的现场。 */
export interface DeviceFlowFacts {
  flowId?: string
  userCode: string
  verificationUri: string
  pollIntervalMs?: number
}

/** 贴码流的现场。`instructions` 是后端原话,原样显示。 */
export interface PasteFlowFacts {
  flowId?: string
  state: string
  instructions: string
}

/**
 * 登录流的当下。`kind: null` = 没有在登录 —— 这不是第四种流,是「没在跑」。
 * `error` 是**服务商原话**,原样显示(交接稿 §4b:失败要显示错误原文)。
 */
export interface AuthFlowState {
  kind: OAuthFlowKind | null
  device?: DeviceFlowFacts
  paste?: PasteFlowFacts
  /** 贴码框里那个正在打的码。 */
  code: string
  /**
   * 正在起步 / 正在提交码 —— 钮上转 spinner 的那一档。
   *
   * 它是**登录流状态机**(kind / device / paste / code / busy / error 六格一体)
   * 的一档,而这台状态机本身**按 providerId 逐坑分格**存
   * (`authFlow: Record<providerId, AuthFlowState>`);消费面 `OAuthCard` 只读
   * 自己那一坑、只禁自己那颗钮 —— 没有「一坑在登录、整面禁灰」这回事。
   * 换句话说这里的忙态是**流程的一个档位**(与 kind/error 同生共死,回到
   * `IDLE_AUTH_FLOW` 时一起归零),不是一颗写路布尔。
   * 什么时候该迁:若日后把 `start` / `submit` 两步各自拆成一条 mutation
   * (那时忙态的产地就变成那两发写、而不是这台状态机),这一格随之退役。
   *
   * ui-consume-allow: async-busy-boolean — 逐坑分格,粒度已经合律③;它是登录流
   * 状态机的一档而非写路布尔,今天没有一条 mutation 可挂。理由全文见上。
   */
  busy: boolean
  error?: string
}

export const IDLE_AUTH_FLOW: AuthFlowState = { kind: null, code: '', busy: false }

/**
 * `start` 的答案 → 这一屏画哪种流。判据见文件头。
 * 起步就失败(`success === false`)时返回 null —— 那时该画的是错误,不是流程。
 */
export function flowKindOf(response: OAuthStartResponse): OAuthFlowKind | null {
  if (!response.success) return null
  if (response.userCode && response.verificationUri) return 'device'
  if (response.requiresCodeEntry) return 'paste'
  return 'browser'
}

/** 后端那句「还没授权,接着等」。命中就继续轮询,不算失败。 */
export function devicePollShouldContinue(pollStatus?: string, error?: string): boolean {
  return pollStatus === 'authorization_pending' || error === 'authorization_pending'
}

/** 服务商喊慢一点。 */
export function devicePollShouldSlowDown(pollStatus?: string, error?: string): boolean {
  return pollStatus === 'slow_down' || error === 'slow_down'
}

/** 这一轮是**终局失败**(码过期 / 被拒),不该再问下去。 */
export function devicePollIsFatal(error?: string): boolean {
  return error === 'expired_token' || error === 'access_denied'
}

/**
 * 登录态的三档。**`expired` 不是 `signedOut`** —— 「登过但令牌过期了」要说
 * 「需要重新授权」,说「未登录」等于让人再走一遍完整登录流。
 */
export type AuthStanding = 'signedOut' | 'expired' | 'signedIn'

export function standingOf(status: OAuthStatusResponse | undefined): AuthStanding {
  if (!status?.isLoggedIn) return 'signedOut'
  return status.isExpired ? 'expired' : 'signedIn'
}

/** 「MM-DD HH:mm」。与 `projection.formatFetchedAt` 同一手,理由也同一条。 */
export function formatMoment(ms: number | undefined): string | null {
  if (!ms) return null
  const at = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}
