/**
 * 一条助手消息的**来源清单**(P4-3)。
 *
 * 联网搜索的引用以 `provider-data` 落在消息上(P3-5a:Grok 流末顶层
 * `citations[]`),一个回合一条 part;多回合就是多条。这里做的只有三件事:
 * 把认得的那几条挑出来、按 URL 去重、给每条起一个短标签 —— 呈现是尾部**一行**,
 * 不是每回合一行,所以合并发生在这里而不是模板里。
 *
 * 认不认由契约层的 `isProviderCitations` 说了算(按 `type` 收窄):codex 的
 * `encrypted-reasoning`、openrouter 的 `reasoning-details` 走同一格 part,
 * 在这里一条都不剩。
 */
import { isProviderCitations } from '@shared/ipc/chat'
import type { ContentPart } from '@/types'

export interface MessageCitation {
  /** 原始 URL —— 点击与 hover 全链接都用它。 */
  url: string
  /** 屏幕上那几个字:域名优先,退化成截短的 URL。 */
  label: string
}

/** 标签超过这个长度就截断(域名解析不出来时才走到这一步)。 */
const LABEL_MAX = 42

/**
 * 一条引用在屏幕上叫什么。
 *
 * 域名是人在"这条说法从哪来"这个问题上真正想看的东西;完整 URL 留给 hover。
 * `www.` 是纯噪声,去掉。解析不出主机名(相对路径、data: 之类)就退回截短原文,
 * 不猜。
 */
export function citationLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host) return host
  } catch {
    // 落到下面的截断分支。
  }
  return url.length > LABEL_MAX ? `${url.slice(0, LABEL_MAX - 1)}…` : url
}

/**
 * 这条消息的全部引用,去重后按**首次出现**排序。
 *
 * 首次出现而不是字典序:引用的先后是模型检索的先后,重排它等于编造了一个
 * 不存在的优先级。
 */
export function collectMessageCitations(
  parts: readonly ContentPart[] | undefined,
): MessageCitation[] {
  if (!parts || parts.length === 0) return []

  const seen = new Set<string>()
  const citations: MessageCitation[] = []

  for (const part of parts) {
    if (part.type !== 'provider-data') continue
    if (!isProviderCitations(part.providerData)) continue

    for (const raw of part.providerData.citations) {
      const url = raw.trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      citations.push({ url, label: citationLabel(url) })
    }
  }

  return citations
}
