/**
 * 退役 provider 的会话改写(A6-b,2026-09-26,`docs/design/acp-integration-2026-09.md` §11.7)。
 *
 * Claude SDK 连接器(provider `claude-code-agent`)退役后,Claude Code 是 ACP 名册里的一台
 * (provider `acp`、model = agent id `claude-code`)。老会话的外壳上还记着
 * `lastProvider: 'claude-code-agent'` —— 不改写,下一条消息就去找一个已经不存在的 provider。
 *
 * 这里只有一张表和一个纯函数:外壳(`meta.json` 那一层)进来,命中就就地改那两格并答
 * 「从哪改到哪」。**账本不动**:`events.jsonl` 里当年那几条 `session/model-changed` 是历史,
 * 改写的是「下一轮往哪儿发」这一个当下的事实。落盘由仓库在冷加载时做一次(见
 * `session-repository.ts` 的 `persistRetiredProviderRewrite`)。
 */

export interface RetiredProviderTarget {
  provider: string
  model: string
}

/** 退役 provider id → 它的接班人。 */
export const RETIRED_SESSION_PROVIDERS: Readonly<Record<string, RetiredProviderTarget>> = {
  'claude-code-agent': { provider: 'acp', model: 'claude-code' },
}

export interface RetiredProviderRewrite {
  from: { provider: string; model?: string }
  to: RetiredProviderTarget
}

/**
 * 命中退役表就把 `lastProvider` / `lastModel` 改成接班人并答改写记录;没命中答 `undefined`
 * 且一个字不碰。幂等:改过一次的外壳再进来就不再命中。
 */
export function rewriteRetiredSessionProvider(
  session: { lastProvider?: string; lastModel?: string } | null | undefined,
): RetiredProviderRewrite | undefined {
  const provider = session?.lastProvider
  if (!session || typeof provider !== 'string') return undefined
  const target = RETIRED_SESSION_PROVIDERS[provider]
  if (!target) return undefined
  const from = { provider, ...(session.lastModel !== undefined ? { model: session.lastModel } : {}) }
  session.lastProvider = target.provider
  session.lastModel = target.model
  return { from, to: { ...target } }
}
