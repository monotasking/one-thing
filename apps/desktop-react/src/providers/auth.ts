import type { OAuthStartResponse, OAuthStatusResponse } from '@shared/ipc/oauth'

/**
 * 订阅登录流。**流形由后端的答案定,不由名册上的 `oauthFlow` 定** ——
 * 这一条是照着 Vue 壳 `useProviderAuth.ts:91-136` 抄的,而它那么写是有道理的:
 * `OAuthStartResponse` 上确实有一个 `flowKind` 字段,但真正决定「这一屏画什么」
 * 的是**后端这一次到底给没给那几样东西**。给了设备码就画设备码;`flowKind` 说
 * 是设备码而 `userCode` 没给,画出来也是一个空框。
 *
 * 三种流,判据按顺序取第一条命中的:
 *  ① `userCode` + `verificationUri` → **设备码流**:大字码 + 授权页链接。
 *  ② `requiresCodeEntry`            → **贴码流**:授权页链接 + 贴码框。
 *  ③ 其余                            → **浏览器回调流**:授权页链接,等回调。
 *
 * **流的生命周期在后端**(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.1):
 * 设备码轮询、回调等待、到点超时、取消都在 `OnethingAuthService` 里,相位变化经全局事件
 * `oauth:flow` 推过来。这边只订阅 —— 从前那两台轮询循环(60×5s / 2s×5min)与世代号都没了。
 */
export type OAuthFlowKind = 'device' | 'paste' | 'browser'

/** 设备码流的现场。 */
export interface DeviceFlowFacts {
  userCode: string
  /** 授权页(后端优先给 `verification_uri_complete`,点开就是确认页)。 */
  verificationUri: string
}

/** 贴码流的现场。`instructions` 是后端原话,原样显示。 */
export interface PasteFlowFacts {
  state: string
  instructions: string
  /** 授权页。从前贴码流从不把它给用户看,于是没自动打开时就无路可走。 */
  authUrl: string
}

/** 浏览器回调流的现场。 */
export interface BrowserFlowFacts {
  authUrl: string
}

/** 一条流的终局里「屏还要留着」的那两档:失败(给重试)与超时。完成 / 取消直接回空闲。 */
export type AuthFlowEnding = 'failed' | 'expired'

/**
 * 登录流的当下。`kind: null` = 没有在登录 —— 这不是第四种流,是「没在跑」。
 * `error` 是**服务商原话**,原样显示(交接稿 §4b:失败要显示错误原文)。
 */
export interface AuthFlowState {
  kind: OAuthFlowKind | null
  /** 后端这条流的 id —— `oauth:flow` 事件与 `oauth.cancel` 都按它认。 */
  flowId?: string
  /**
   * 这条流登进**哪个空间的哪一条**(批 8)。起流那一刻定下,之后贴码提交照它带 ——
   * 后端按 (provider, 空间, 条目) 认流,中途换了空间也不会把码交给别的空间的流。
   * `entryId` 缺席 = 添加账号(追加);带上 = 重新授权那一条。
   */
  target?: { spaceId: string; entryId?: string }
  device?: DeviceFlowFacts
  paste?: PasteFlowFacts
  browser?: BrowserFlowFacts
  /**
   * 授权页是不是**真的**被打开了(桌面上 `openExternal` 成功)。`false` = 网页壳(不自动开)
   * 或桌面上打开失败 —— 那时状态句说「点『打开』去授权」,不说「已打开授权页」。
   */
  opened: boolean
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
  /** 这条流已经终局(后端说的):失败 / 超时。屏留着给原话与重试。 */
  ended?: AuthFlowEnding
  error?: string
}

export const IDLE_AUTH_FLOW: AuthFlowState = { kind: null, code: '', busy: false, opened: false }

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

/** 这一条流的授权页网址(三流都有;没有就是空串)。 */
export function authPageUrlOf(flow: AuthFlowState): string {
  if (flow.kind === 'device') return flow.device?.verificationUri ?? ''
  if (flow.kind === 'paste') return flow.paste?.authUrl ?? ''
  if (flow.kind === 'browser') return flow.browser?.authUrl ?? ''
  return ''
}

/** 服务商那句「你在授权页点了拒绝」(RFC 6749 §4.1.2.1 / RFC 8628 §3.5)。 */
export function isAccessDenied(error?: string): boolean {
  return error === 'access_denied'
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
