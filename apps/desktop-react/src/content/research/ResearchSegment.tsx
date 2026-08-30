import { useCallback, useRef, useState } from 'react'
import { useT, type TFn } from '../../i18n'
import { resolveIcon } from '../../components/icons'
import { Spinner } from '../../ui/Spinner'
import type { BlockCtx } from '../blocks/registry'
import type {
  ResearchActivity,
  ResearchEpisodeModel,
  ResearchQueryGroup,
  ResearchSource,
} from '../model/segments'
import { ToolDrawer } from '../tools/ToolDrawer'
import { EXPANDABLE_STATUSES, formatDuration } from '../tools/status'
import { sourceStep, stackDomains } from './episode'
import { Favicon, FaviconStack } from './Favicon'
import { useResearchReveal } from './reveal'
import s from './Research.module.css'

const CaretIcon = resolveIcon('ChevronRight')

/**
 * 检索段 —— 四件套里的前三件(§5.3):**流中态行 / 收起行 / 展开清单**。
 * 第四件(消息尾来源条)在 SourceFoot.tsx,因为它挂的是消息而不是段。
 *
 * ── 为什么它不是又一个 ToolGroup ──────────────────────────────────────────
 * 一组工具调用收起时说的是「执行了 N 步」——**计数句**,回答「刚才那段沉默里发生了
 * 多大的事」。一段检索收起时说的是「检索 · N 个来源」——**来源清单**,回答「这段话
 * 的依据是谁说的」。后者不是前者的一种皮肤:调用次数在这里几乎没有意义(一次搜索
 * 带回六条来源),而来源与查询词在 tool-group 里根本没有位置。所以是两种段,
 * 不是一个段的两个 variant。
 *
 * ── 抽屉是复用的,不是重写的 ──────────────────────────────────────────────
 * 来源行点开的是 C1 的 `ToolDrawer`,与工具卡逐字同一件东西 —— 一条来源背后就是
 * 一次真实调用,「看这条来源的详情」和「看那次调用的详情」是同一个问题。
 *
 * ── 少画的那一格:「引用 N」小丸 ───────────────────────────────────────────
 * 定稿的来源行右端还有一枚「被正文引用了几次」的小丸。**它今天不画**:正文里没有
 * 引用的产地(勘察:62 条带检索的回复里 0 条带 `[sN.M]` 之类的标记),那个 N 只能
 * 编。等模型输出约定或引擎结构化 citation 落地,这一格与正文角标同批进来。
 */
export function ResearchSegment({
  episode,
  id,
  ctx,
}: {
  episode: ResearchEpisodeModel
  /** 段的稳定身份 —— 消息尾来源条按它点名(见 reveal.ts)。 */
  id: string
  ctx: BlockCtx
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen((value) => !value), [])
  const ref = useRef<HTMLDivElement>(null)

  useResearchReveal(id, () => {
    setOpen(true)
    ref.current?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  })

  // 还在跑:画流中态行。**没有收起行可画** —— 这一刻「N 个来源」还在变,
  // 把一个正在长的数摆成结论是骗人;等它收场再说。
  if (episode.running) {
    return (
      <div ref={ref} className={s.episode} data-research-id={id} data-research-live>
        <ResearchLive t={t} episode={episode} />
      </div>
    )
  }

  const domains = stackDomains(episode.sources)

  return (
    <div
      ref={ref}
      className={s.episode}
      data-research-id={id}
      data-open={open || undefined}
    >
      <button type="button" className={s.head} onClick={toggle} aria-expanded={open}>
        <CaretIcon className={s.caret} strokeWidth={2} aria-hidden="true" />
        <FaviconStack domains={domains} />
        <span className={s.headText}>
          {t('chat.research.label')}
          <span className={s.sep}>·</span>
          {t('chat.research.sources', { n: episode.sources.length })}
        </span>
        <span className={s.right}>
          {episode.failed > 0 && (
            <span className={s.failed}>{t('chat.toolGroup.failed', { n: episode.failed })}</span>
          )}
          {episode.queries.length > 0 && (
            <span className={s.meta}>
              {t('chat.research.queries', { n: episode.queries.length })}
            </span>
          )}
          {episode.durationMs !== undefined && (
            <span className={s.duration}>{formatDuration(t, episode.durationMs)}</span>
          )}
        </span>
      </button>

      {open && <ResearchList t={t} episode={episode} ctx={ctx} />}
    </div>
  )
}

/**
 * 流中态行:spinner + 「正在阅读 web.dev — 标题…」,底下一条小灰副行报进度。
 *
 * 说的是**最后一条还没收场的调用**,所以它随着检索推进自己换词 —— 这就是定稿里
 * 那句「滚动更新」:不是一个动画,是同一行字换内容。
 */
function ResearchLive({ t, episode }: { t: TFn; episode: ResearchEpisodeModel }) {
  const text = activityText(t, episode.active)
  return (
    <div className={s.live}>
      <span className={s.liveHead}>
        <Spinner size="sm" className={s.liveSpinner} />
        <span className={s.liveText} title={text}>
          {text}
        </span>
      </span>
      <span className={s.liveSub}>
        {t('chat.research.progress', { q: episode.queries.length, p: episode.openedCount })}
      </span>
    </div>
  )
}

/** 展开清单:按查询词分组,组头 + 来源行。 */
function ResearchList({
  t,
  episode,
  ctx,
}: {
  t: TFn
  episode: ResearchEpisodeModel
  ctx: BlockCtx
}) {
  return (
    <div className={s.list}>
      {episode.groups.map((group) => (
        <section className={s.group} key={group.id}>
          <h5 className={s.queryHead}>{groupHeadText(t, group)}</h5>
          {group.sources.length === 0 ? (
            // 一组都搜空了**也要说出来**:整组抹掉会让人以为模型压根没搜这一条。
            <p className={s.groupEmpty}>{t('chat.research.noSources')}</p>
          ) : (
            <ul className={s.sources}>
              {group.sources.map((source) => (
                <li key={source.id}>
                  <SourceRow t={t} episode={episode} source={source} ctx={ctx} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

/** 一条来源:favicon + 标题 + 域名;点开是那次调用的抽屉。 */
function SourceRow({
  t,
  episode,
  source,
  ctx,
}: {
  t: TFn
  episode: ResearchEpisodeModel
  source: ResearchSource
  ctx: BlockCtx
}) {
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen((value) => !value), [])

  const step = sourceStep(episode, source)
  // 与工具行同一条:结局没定下来就不给按钮。按得动却什么也不发生的钮比没有钮更费人。
  const expandable = step !== undefined && EXPANDABLE_STATUSES.has(step.row.status)

  const face = (
    <>
      <Favicon domain={source.domain} />
      <span className={s.sourceTitle}>{source.title ?? source.url}</span>
      <span className={s.sourceDomain}>{source.domain}</span>
      {source.openStatus === 'failed' && (
        // 「打开过但没读到正文」是真实且常见的结局(反爬 / 无正文)。不说的话,
        // 这一行看起来就像模型读过这一页 —— 那是屏幕在替它说谎。
        <span className={s.sourceFailed}>{t('chat.research.openFailed')}</span>
      )}
    </>
  )

  return (
    <div className={s.source} data-source-open={open || undefined}>
      {expandable ? (
        <button
          type="button"
          className={s.sourceFace}
          onClick={toggle}
          aria-expanded={open}
          title={source.url}
        >
          {face}
        </button>
      ) : (
        <div className={s.sourceFace} title={source.url}>
          {face}
        </div>
      )}
      {open && step && <ToolDrawer call={step.call} ctx={ctx} />}
    </div>
  )
}

/** 组头:署了名的说查询词,未署名的说「直接打开」(不给它编一个查询词)。 */
function groupHeadText(t: TFn, group: ResearchQueryGroup): string {
  return group.query === undefined
    ? t('chat.research.direct')
    : t('chat.research.queryHead', { query: group.query })
}

/**
 * 流中态那一句。
 *
 * 域名与标题都可能缺席(参数里没写 title、URL 解析不了),缺一格就退一档说法 ——
 * 不拿占位符把句子撑起来。
 */
export function activityText(t: TFn, active: ResearchActivity | undefined): string {
  if (!active) return t('chat.research.working')
  if (active.kind === 'search') {
    return active.query ? t('chat.research.searching', { query: active.query }) : t('chat.research.working')
  }
  if (!active.domain) return t('chat.research.working')
  return active.title
    ? t('chat.research.reading', { domain: active.domain, title: active.title })
    : t('chat.research.readingPlain', { domain: active.domain })
}

/** 减少动态偏好下不做平滑滚动(全仓惯例:动效可以没有,不能不可控)。 */
function scrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'auto'
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
