import { useMemo } from 'react'
import { useT } from '../../i18n'
import { segmentKey } from '../assemble/key'
import type { SegmentModel } from '../model/segments'
import { FaviconStack } from './Favicon'
import { revealResearch } from './reveal'
import { stackDomains } from './episode'
import s from './Research.module.css'

/**
 * 四件套的第四件:**消息尾来源条**(§5.3)。
 *
 * 一枚小丸:几张站点脸 + 「N 个来源」。点它 → 那一段检索展开并滚进视野。
 *
 * ── 为什么它挂在消息上而不是段上 ──────────────────────────────────────────
 * 它回答的是「这条回复的依据在哪」—— 一个关于**整条消息**的问题。检索段自己在正文
 * 中间(模型先搜、再说),读到末尾时它已经滚过去了;来源条就是把它捞回来的把手。
 * 所以它是消息的尾注,不是段的一部分。
 *
 * ── 一段检索一枚丸 ────────────────────────────────────────────────────────
 * 定稿画的是「一枚」,那是因为一条消息通常只有一段检索。真出现两段(说一句、
 * 搜一轮、再说一句、再搜一轮)时是两枚 —— 合成一枚就必须回答「点了滚到哪一段」
 * 和「N 是两段之和吗」,而两个答案都会让那句「N 个来源」不再对得上任何一份清单。
 * 规则始终是同一条:**一段检索一枚丸**。
 */
export function MessageSourceFoot({
  segments,
  messageId,
}: {
  segments: readonly SegmentModel[]
  messageId: string
}) {
  const t = useT()
  const foots = useMemo(() => researchFoots(segments, messageId), [segments, messageId])
  if (foots.length === 0) return null

  return (
    // data-prose:节奏表的钩子 —— 尾来源条是消息尾注,按物件档与正文拉开
    // (content/ChatStream.module.css)。
    <div className={s.foot} data-testid="research-foot" data-prose="object">
      {foots.map((foot) => (
        <button
          type="button"
          key={foot.id}
          className={s.footPill}
          onClick={() => revealResearch(foot.id)}
          aria-label={t('chat.research.footLabel')}
        >
          <FaviconStack domains={foot.domains} />
          {t('chat.research.sources', { n: foot.count })}
        </button>
      ))}
    </div>
  )
}

export interface ResearchFoot {
  /** 与检索段那边算出来的是同一个字符串 —— 两处都走 `segmentKey`,不各拼一遍。 */
  id: string
  count: number
  domains: string[]
}

/**
 * 消息里有哪几段检索值得挂一枚丸。
 *
 * **一条来源都没有的段不挂** —— 一枚写着「0 个来源」的丸只会骗人点一次。
 * 还在跑的段也不挂:那时数还在变,而丸说的是结论。
 */
export function researchFoots(
  segments: readonly SegmentModel[],
  messageId: string,
): ResearchFoot[] {
  const out: ResearchFoot[] = []
  segments.forEach((segment, index) => {
    if (segment.kind !== 'research') return
    const { episode } = segment
    if (episode.running || episode.sources.length === 0) return
    out.push({
      id: segmentKey(messageId, index, segment),
      count: episode.sources.length,
      domains: stackDomains(episode.sources),
    })
  })
  return out
}
