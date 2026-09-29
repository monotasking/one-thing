import { useId, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { CARD_FLIP_MS } from '../../components/motion'
import { ButtonBase } from '../../ui/ButtonBase'
import { useFlipHeight } from '../../ui/flip-height'
import { segmentKey } from '../assemble/key'
import type { BlockCtx } from '../blocks/registry'
import type { ResearchEpisodeModel, SegmentModel } from '../model/segments'
import { FaviconStack } from './Favicon'
import { ResearchList, useAnchoredToggle } from './ResearchSegment'
import { stackDomains } from './episode'
import s from './Research.module.css'

/**
 * 四件套的第四件:**消息尾来源条**(§5.3)。
 *
 * 一枚小丸:几张站点脸 + 「N 个来源」。点它 → **就在丸下面**展开这段检索的来源清单,
 * 再点收起。
 *
 * ── 原地看,不跳(09-27 用户令)──────────────────────────────────────────
 * 从前点丸是「滚到正文中间那一段检索并把它展开」。可人读到消息末尾想看依据时,
 * 被拽回上面去是在打断他 —— 看完还得自己找回刚才读到哪。现在丸下面直接摊开
 * **同一张清单**(`ResearchList`,与检索段展开态逐字同一件),读完收起,
 * 视线一直在原地。那条「喊话让检索段自己展开」的细线(`reveal.ts`)随之退役。
 *
 * ── 为什么它挂在消息上而不是段上 ──────────────────────────────────────────
 * 它回答的是「这条回复的依据在哪」—— 一个关于**整条消息**的问题,是消息的尾注。
 *
 * ── 一段检索一枚丸 ────────────────────────────────────────────────────────
 * 真出现两段(说一句、搜一轮、再说一句、再搜一轮)时是两枚:合成一枚就必须回答
 * 「N 是两段之和吗」,而那会让「N 个来源」不再对得上任何一份清单。同一时刻只开一枚
 * (两张清单叠在一起分不清哪张是哪枚丸的)。
 */
export function MessageSourceFoot({
  segments,
  messageId,
  ctx,
}: {
  segments: readonly SegmentModel[]
  messageId: string
  ctx: BlockCtx
}) {
  const t = useT()
  const foots = useMemo(() => researchFoots(segments, messageId), [segments, messageId])
  const [openId, setOpenId] = useState<string | null>(null)
  // 看过的清单不卸载(收起只是 hidden):再开时是同一批节点,不重新「长」一遍。
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  const boxRef = useRef<HTMLDivElement>(null)
  useFlipHeight(boxRef, openId ?? 'closed', { durVar: '--dur-card-flip', durMs: CARD_FLIP_MS })
  const baseId = useId()
  const anchored = useAnchoredToggle(boxRef)

  if (foots.length === 0) return null

  const toggle = (id: string) => {
    // 开合先报给聊天流(按住这条来源条的顶边),再写状态 —— 判词在 useAnchoredToggle。
    setOpenId(anchored(openId !== id) ? id : null)
    if (!seen.has(id)) setSeen(new Set(seen).add(id))
  }

  return (
    // data-prose:节奏表的钩子 —— 尾来源条是消息尾注,按物件档与正文拉开
    // (content/ChatStream.module.css)。
    <div ref={boxRef} className={s.footBox} data-testid="research-foot" data-prose="object">
      <div className={s.foot}>
        {foots.map((foot) => (
          /* 一枚**药丸**(favicon 堆 + 一句读数),视觉本该定制 ——
           * 三类判的第三类,皮肤留本地、清 UA 归 `ui/ButtonBase`。 */
          <ButtonBase
            key={foot.id}
            className={s.footPill}
            onClick={() => toggle(foot.id)}
            aria-expanded={openId === foot.id}
            aria-controls={seen.has(foot.id) ? `${baseId}-${foot.id}` : undefined}
          >
            <FaviconStack domains={foot.domains} />
            {t('chat.research.sources', { n: foot.count })}
          </ButtonBase>
        ))}
      </div>
      {foots.map((foot) =>
        seen.has(foot.id) ? (
          <div
            key={foot.id}
            id={`${baseId}-${foot.id}`}
            className={s.footList}
            hidden={openId !== foot.id}
          >
            <ResearchList t={t} episode={foot.episode} ctx={ctx} anchorRef={boxRef} />
          </div>
        ) : null,
      )}
    </div>
  )
}

export interface ResearchFoot {
  /** 与检索段那边算出来的是同一个字符串 —— 两处都走 `segmentKey`,不各拼一遍。 */
  id: string
  count: number
  domains: string[]
  /** 丸点开就地画的那张清单读它。 */
  episode: ResearchEpisodeModel
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
      episode,
    })
  })
  return out
}
