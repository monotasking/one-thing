import type { SessionTokenUsage, TokenUsage } from '@shared/ipc.js'
import {
  clearOnethingSessionUsage,
  getOnethingSessionUsage,
  updateOnethingSessionUsage,
} from '@onething/runtime/sessions'
import * as store from '../store.js'
import { deepEqual } from './shadow.js'
import { appendSessionShadowLine, summarizeShadowDiff } from './shadow.js'
import { bumpSessionShadowStats } from './event-stats.js'
import { peekSessionAccount } from './projection-cache.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.usage')

/**
 * Update session usage after a streamed turn finishes.
 * Persists to disk for durability across app restarts.
 */
export function updateSessionUsage(
  sessionId: string,
  usage: TokenUsage,
  lastTurnUsage?: { inputTokens: number; outputTokens: number },
): void {
  // §17.7 #15 裁定 1:**账本口径为准**。会话账已经把每一次请求的 usage 各计一次
  // (`request/response.usage` 累加),所以这里不再往容器上做加法 —— 落格即可。
  // 落不了(这条会话没有账:echo / 测试替身那条泳道)才回落老加法,行为逐字如旧。
  if (!landSessionAccountUsage(sessionId)) {
    updateOnethingSessionUsage({
      sessionId,
      usage,
      lastTurnUsage,
      updateSessionTokenUsage: (id, nextUsage, nextLastTurnUsage) =>
        store.updateSessionTokenUsage(id, nextUsage, nextLastTurnUsage),
    })
  }
  compareSessionUsageAgainstLedger(sessionId)
}

/**
 * **按账落格**(§17.7 #15 裁定 1 的落点)。
 *
 * 三个就地写者的原落点时刻各调它一次:引擎收尾(用量三格)、provider-finish 与
 * 压缩收尾(上下文两格)。产地只有一个 —— 会话账折叠。
 *
 * @returns 落没落成。`false` = 这条会话此刻没有账(没记账的泳道 / 账还没起底),
 *          调用方回落老写法,行为与收口前逐字相同(成对交付)。
 */
export function landSessionAccountUsage(sessionId: string): boolean {
  const account = peekSessionAccount(sessionId)
  if (!account) return false
  // 账上一格都没有(这条会话还没有过一次请求)= 没什么可落的。让老写者说话,
  // 否则会把 echo 泳道那份就地写的用量抹成 0。
  if (
    account.totalTokens === 0
    && account.totalInputTokens === 0
    && account.totalOutputTokens === 0
    && account.contextSize === undefined
    && account.lastInputTokens === undefined
  ) {
    return false
  }
  return store.landSessionAccountUsage(sessionId, {
    totalInputTokens: account.totalInputTokens,
    totalOutputTokens: account.totalOutputTokens,
    totalTokens: account.totalTokens,
    ...(account.contextSize !== undefined ? { contextSize: account.contextSize } : {}),
    ...(account.lastInputTokens !== undefined
      ? { lastInputTokens: account.lastInputTokens }
      : {}),
  })
}

/**
 * **usage 三格对拍**(§17.7 #15 的影子,这一批只比不接管)。
 *
 * 比对点选在**写完那一刻**,不是 run 收尾:容器这三格由这个写者盖,而账本那边
 * `request/response.usage` 早在本轮请求收场时就落了 —— 在写者写完的这一瞬,两边
 * 说的是同一件事。挂在 run/end 上比会稳定地看见"容器还没写"的那一帧
 * (实测:battery 里整栏 B 侧恒为 0,而同一条会话静默几秒后两边逐格相等)。
 *
 * 事实都在流上,所以真差只可能来自**重复计数**或**某一格没有产地**;时序差
 * 由这个比对点消掉。
 */
function compareSessionUsageAgainstLedger(sessionId: string): void {
  try {
    const account = peekSessionAccount(sessionId)
    if (!account) return
    const snapshot = store.getSessionTokenUsage(sessionId)
    if (!snapshot) return
    const container = {
      totalInputTokens: snapshot.totalInputTokens ?? 0,
      totalOutputTokens: snapshot.totalOutputTokens ?? 0,
      totalTokens: snapshot.totalTokens ?? 0,
      contextSize: snapshot.contextSize ?? 0,
      lastInputTokens: snapshot.lastInputTokens ?? 0,
    }
    const folded = {
      totalInputTokens: account.totalInputTokens,
      totalOutputTokens: account.totalOutputTokens,
      totalTokens: account.totalTokens,
      contextSize: account.contextSize ?? 0,
      lastInputTokens: account.lastInputTokens ?? 0,
    }
    bumpSessionShadowStats({ usageChecks: 1 })
    if (deepEqual(folded, container)) return
    const { diff, truncated } = summarizeShadowDiff(folded, container)
    appendSessionShadowLine({
      time: Date.now(),
      sessionId,
      kind: 'usage',
      diff,
      ...(truncated ? { truncated } : {}),
    })
    bumpSessionShadowStats({ usageMismatches: 1 })
  } catch (error) {
    // 影子坏了不许影响记账。
    log.warn('usage shadow compare failed', { sessionId }, error)
  }
}

export function getSessionUsage(sessionId: string): SessionTokenUsage {
  return getOnethingSessionUsage({
    sessionId,
    getSessionTokenUsage: id => store.getSessionTokenUsage(id),
  })
}

export function clearSessionUsage(sessionId: string): void {
  clearOnethingSessionUsage(sessionId)
}
