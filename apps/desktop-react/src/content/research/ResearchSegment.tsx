import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useT, type TFn } from '../../i18n'
import { resolveIcon } from '../../components/icons'
import { CARD_FLIP_MS, COPY_FEEDBACK_MS, currentMotionTier } from '../../components/motion'
import { Dots } from '../../ui/Dots'
import { useFlipHeight } from '../../ui/flip-height'
import { Fold, FoldBody, FoldTrigger } from '../../ui/Fold'
import { IconButton } from '../../ui/IconButton'
import { REVEAL_SCOPE, Reveal } from '../../ui/Reveal'
import { Segmented } from '../../ui/Segmented'
import { Tooltip } from '../../ui/Tooltip'
import type { BlockCtx } from '../blocks/registry'
import type {
  ResearchEpisodeModel,
  ResearchQueryGroup,
  ResearchSource,
  ResearchStep,
} from '../model/segments'
import { copyPathAnnouncing } from '../FileActionsMenu'
import { ToolDrawer } from '../tools/ToolDrawer'
import { EXPANDABLE_STATUSES, formatDuration } from '../tools/status'
import { useGeometryReport } from '../geometry-report'
import { sourceStep, stackDomains } from './episode'
import { openSourceUrl } from './open-source'
import { Favicon, FaviconStack } from './Favicon'
import s from './Research.module.css'

const CaretIcon = resolveIcon('ChevronRight')
const SearchIcon = resolveIcon('Search')
const OpenIcon = resolveIcon('Globe')
const CopyIcon = resolveIcon('Copy')
const CheckIcon = resolveIcon('Check')
const RawIcon = resolveIcon('Wrench')

/**
 * 检索段 —— 四件套里的前三件(§5.3):**流中态步骤单 / 收起行 / 展开清单**。
 * 第四件(消息尾来源条)在 SourceFoot.tsx,因为它挂的是消息而不是段。
 * 样例页:`docs/web-search-proposal-2026-09-27.html`(09-27 重做)。
 *
 * ── 三个时刻,各答一个问题 ────────────────────────────────────────────────
 *  · 流中:「它在干嘛、走了多远」—— 一张步骤单,每次搜索 / 每次阅读一行;
 *  · 收起:「这段话靠不靠得住」—— 一句灰字,多说一件事:**细读了几篇**。N 个来源
 *    里只有 M 个是真打开读过的,其余只在搜索结果里露过面;两者的分量不一样;
 *  · 展开:「这句话出自哪」—— 来源两行(标题 / 域名 + 摘要),读过的带「已读」,
 *    点开是这一页的摘录,工具原始输出降到「看原始调用」后面。
 *
 * ── 折叠走库件,不手写(09-27 用户报:展开收起时里面的东西在闪、在变)──────
 * 从前这里是 `{open && <List/>}` + 行内按开合换形(摘要行藏掉、快捷钮卸载、标题
 * 改成可折行)—— 每开一次清单重挂一遍(站点图标从字母圆片重新「长」成图标)、
 * 每点一行那一行自己先变一次形。现在三件库件各管一件事:
 *  · `ui/Fold` —— 开合的行为与 a11y;正文收起是 `hidden`,**不卸载**(树/面常驻
 *    铁律),再开时是同一批 DOM 节点、同一份筛选与展开状态;
 *  · `ui/flip-height` —— 高走过去,不跳过去(与思考段 / 工具卡同一个原语、同一档时长);
 *  · `ui/Reveal` —— 行尾快捷钮占位常驻、只动透明度,出现时不推开任何东西。
 * 行的外形**两态逐像素相同**:展开只在它下面多出一块,行本身一个字不动。
 * 正文第一次打开才挂载(清单常常几十条而且默认收着),挂上之后就一直在。
 *
 * ── 为什么它不是又一个 ToolGroup ──────────────────────────────────────────
 * 一组工具调用收起时说的是「执行了 N 步」——**计数句**。一段检索收起时说的是
 * 「检索 · N 个来源」——**来源清单**,回答「这段话的依据是谁说的」。所以是两种段,
 * 不是一个段的两个 variant。
 *
 * ── 少画的那一格:引用角标 ─────────────────────────────────────────────────
 * 正文里没有引用的产地(勘察:62 条带检索的回复里 0 条带引用标记),那个数只能编。
 */
export function ResearchSegment({
  episode,
  id,
  ctx,
}: {
  episode: ResearchEpisodeModel
  /** 段的稳定身份(渲染 key / 门的取件口)。 */
  id: string
  ctx: BlockCtx
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  // 结构 = 流中 / 收起 / 展开三态:任一次换态,这一块的高走过去。
  useFlipHeight(boxRef, episode.running ? 'live' : open ? 'open' : 'closed', FLIP)
  const toggle = useAnchoredToggle(boxRef)

  // 还在跑:画步骤单。**没有收起行可画** —— 这一刻「N 个来源」还在变,
  // 把一个正在长的数摆成结论是骗人;等它收场再说。
  if (episode.running) {
    return (
      // data-prose:节奏表的钩子 —— 检索段按物件档留白(content/ChatStream.module.css)。
      <div ref={boxRef} className={s.episode} data-research-id={id} data-research-live data-prose="object">
        <ResearchLive t={t} episode={episode} />
      </div>
    )
  }

  return (
    <div
      ref={boxRef}
      className={s.episode}
      data-research-id={id}
      data-open={open || undefined}
      data-prose="object"
    >
      <Fold open={open} onOpenChange={(next) => setOpen(toggle(next))}>
        {/* 收起行:结构件(caret + 一行灰字 + 右端读数),行为归 `ui/Fold`,皮肤留本地。 */}
        <FoldTrigger className={s.head}>
          <CaretIcon className={s.caret} strokeWidth={2} aria-hidden="true" />
          <FaviconStack domains={stackDomains(episode.sources)} />
          <span className={s.headText}>
            <span className={s.headLabel}>{t('chat.research.label')}</span>
            <span className={s.sep}>·</span>
            {t('chat.research.sources', { n: episode.sources.length })}
            {episode.openedCount > 0 && (
              <>
                <span className={s.sep}>·</span>
                {t('chat.research.readCount', { n: episode.openedCount })}
              </>
            )}
          </span>
          <span className={s.right}>
            {episode.unreadCount > 0 && (
              <span className={s.failed}>{t('chat.research.unread', { n: episode.unreadCount })}</span>
            )}
            {episode.failedSearches > 0 && (
              <span className={s.failed}>
                {t('chat.research.searchFailed', { n: episode.failedSearches })}
              </span>
            )}
            {episode.queries.length > 0 && (
              <span className={s.meta}>
                {t('chat.research.queries', { n: episode.queries.length })}
              </span>
            )}
            {episode.durationMs !== undefined && (
              <span className={s.duration}>{formatDuration(episode.durationMs)}</span>
            )}
          </span>
        </FoldTrigger>
        <LazyFoldBody open={open}>
          <ResearchList t={t} episode={episode} ctx={ctx} anchorRef={boxRef} />
        </LazyFoldBody>
      </Fold>
    </div>
  )
}

/** 与思考段 / 工具卡同一档:180ms,动效档 none 直切(配方在 `ui/flip-height`)。 */
const FLIP = { durVar: '--dur-card-flip', durMs: CARD_FLIP_MS } as const

/**
 * **开合先报给聊天流,再写状态**(G 线 P2-b 的口,`content/geometry-report.ts`)。
 *
 * 09-27 真机:点开 / 收起一段检索,视口被跟随状态机一把拽走 —— 这一块的高变了,
 * 却没人告诉锚定器「按住它的顶边」。思考段与工具卡一直走这个口,检索段从来没接。
 * 锚是**外面那一整块**(检索段或丸下面那张清单),不是被点的那一行:缩掉的高都在
 * 这一块里,按住它的顶边就按住了缩点以上的一切(工具卡同一条判词)。
 * 返回值就是要写进 state 的那一格 —— 拿不到它就写不了,这是结构保证。
 * 聊天流之外(样例页 / 单测)那个口是恒等,行为一个字不变。
 */
export function useAnchoredToggle(anchorRef: RefObject<HTMLElement | null>) {
  const report = useGeometryReport()
  return useCallback(
    (open: boolean) =>
      report.toggle({
        el: anchorRef.current,
        open,
        durationMs: currentMotionTier() === 'none' ? 0 : CARD_FLIP_MS,
      }),
    [report, anchorRef],
  )
}

/**
 * 第一次打开才挂载的 `FoldBody` —— 挂上之后就不再卸载,收起只是 `hidden`。
 *
 * 清单常常几十条而且默认收着,一上来就全挂等于给每一段检索白建一棵从没人看的树;
 * 可一旦看过,再卸载就是「再开时重新长一遍」—— 那正是要治的闪。
 */
function LazyFoldBody({ open, children }: { open: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(open)
  if (open && !seen) setSeen(true)
  return seen ? <FoldBody>{children}</FoldBody> : null
}

/** 步骤单最多摆几行:更早的收成一句「前面还有 N 步」,这块不随检索变长把正文推走。 */
const LIVE_STEPS = 4

/**
 * 流中态:一张步骤单。
 *
 * 顶上一行是「已找到 N 个来源」+ 找到的站点脸 —— 这次检索有多大、涉及哪些站;
 * 下面每次搜索 / 每次阅读各一行,三格对齐:动词(搜索 / 阅读)· 查询词或页面标题 ·
 * 这一步的结局(「5 条」「已读」「未读到正文」)。还在跑的那一行结局格是 `ui/Dots`。
 *
 * **这里不转圈**(09-02 批 6 兑现禁令):这块衬块长在正文流里,不是状态栏;而且
 * 「正在进行的那一行」本身就在说话,转圈是把同一件事说第二遍。
 */
function ResearchLive({ t, episode }: { t: TFn; episode: ResearchEpisodeModel }) {
  const shown = episode.trail.slice(-LIVE_STEPS)
  const older = episode.trail.length - shown.length
  const found = episode.sources.length

  return (
    <div className={s.live}>
      <div className={s.liveTop}>
        <FaviconStack domains={stackDomains(episode.sources)} />
        <span className={s.liveFound}>
          {found > 0 ? t('chat.research.found', { n: found }) : t('chat.research.working')}
        </span>
        {episode.trail.length > 0 && (
          <span className={s.liveCount}>{t('chat.research.steps', { n: episode.trail.length })}</span>
        )}
      </div>
      {older > 0 && <div className={s.older}>{t('chat.research.olderSteps', { n: older })}</div>}
      {shown.map((step) => (
        <TrailRow key={step.id} t={t} step={step} />
      ))}
    </div>
  )
}

function TrailRow({ t, step }: { t: TFn; step: ResearchStep }) {
  const what = step.kind === 'search' ? step.query : (step.title ?? step.domain)
  const text = what ?? t('chat.research.working')
  return (
    <div className={s.step} data-step-status={step.status}>
      <span className={s.stepVerb}>
        {t(step.kind === 'search' ? 'chat.research.verbSearch' : 'chat.research.verbRead')}
      </span>
      <span className={s.stepWhat}>
        {step.kind === 'open' && step.domain && <Favicon domain={step.domain} />}
        {/* 这一行会截断:全句走 `ui/Tooltip`(禁 native `title=`)。 */}
        <Tooltip content={text}>
          <span className={s.stepText}>{text}</span>
        </Tooltip>
      </span>
      <span className={s.stepResult}>{stepResult(t, step)}</span>
    </div>
  )
}

/** 一步的结局那一格。还在跑 = 三颗点;失败说失败;搜索成功说条数,阅读成功说「已读」。 */
function stepResult(t: TFn, step: ResearchStep) {
  if (step.status === 'running') return <Dots />
  if (step.status === 'failed') {
    return (
      <span className={s.failed}>
        {t(step.kind === 'search' ? 'chat.research.stepFailed' : 'chat.research.openFailed')}
      </span>
    )
  }
  if (step.kind === 'open') return t('chat.research.read')
  if (step.resultCount === undefined) return null
  return step.resultCount === 0
    ? t('chat.research.noResults')
    : t('chat.research.resultCount', { n: step.resultCount })
}

type SourceFilter = 'all' | 'read'

/**
 * 展开清单:可选的「全部 / 只看已读」+ 按查询词分组。
 *
 * 导出给消息尾来源条:丸点开**就地**画的是同一张清单(09-27 用户令:不跳到检索段,
 * 原地看)—— 同一件事两个入口,不写第二份。
 */
export function ResearchList({
  t,
  episode,
  ctx,
  anchorRef,
}: {
  t: TFn
  episode: ResearchEpisodeModel
  ctx: BlockCtx
  /** 外面那一整块(检索段 / 丸下的清单):清单里任何一次变高变矮,都按住它的顶边。 */
  anchorRef: RefObject<HTMLElement | null>
}) {
  const [filter, setFilter] = useState<SourceFilter>('all')
  const toggle = useAnchoredToggle(anchorRef)
  const total = episode.sources.length
  const read = episode.openedCount
  // 只有「读过的是一部分」时这个问题才有意义:一篇没读 / 全读了,两档筛出来一样。
  const filterable = read > 0 && read < total
  const onlyRead = filterable && filter === 'read'

  return (
    <div className={s.list}>
      {filterable && (
        <div className={s.listTop}>
          <Segmented<SourceFilter>
            label={t('chat.research.filterLabel')}
            value={filter}
            // 「只看已读」是变矮、回「全部」是变高 —— 与开合同一句话。
            onChange={(next) => {
              toggle(next === 'all')
              setFilter(next)
            }}
            options={[
              { value: 'all', label: t('chat.research.filterAll', { n: total }) },
              { value: 'read', label: t('chat.research.filterRead', { n: read }) },
            ]}
          />
        </div>
      )}
      {episode.groups.map((group) => {
        // 筛选只**藏**不卸:切回「全部」时是同一批行,点开的那条仍然开着。
        const visible = onlyRead ? group.sources.filter(isRead).length : group.sources.length
        return (
          <section className={s.group} key={group.id} hidden={onlyRead && visible === 0}>
            <h5 className={s.queryHead}>
              {group.query !== undefined && (
                <SearchIcon className={s.queryIcon} strokeWidth={2} aria-hidden="true" />
              )}
              <span className={s.queryText}>{groupHeadText(t, group)}</span>
              {/* 文字读数,不是计数徽(壳的计数禁令只禁徽)。 */}
              {group.sources.length > 0 && (
                <span className={s.queryCount}>
                  {t('chat.research.resultCount', { n: group.sources.length })}
                </span>
              )}
            </h5>
            {group.sources.length === 0 ? (
              // 一组都搜空了**也要说出来**:整组抹掉会让人以为模型压根没搜这一条。
              <p className={s.groupEmpty}>{t('chat.research.noSources')}</p>
            ) : (
              <ul className={s.sources}>
                {group.sources.map((source) => (
                  <li key={source.id} hidden={onlyRead && !isRead(source)}>
                    <SourceRow t={t} episode={episode} source={source} ctx={ctx} toggle={toggle} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

function isRead(source: ResearchSource): boolean {
  return source.openStatus === 'ok'
}

/**
 * 一条来源:两行(标题 + 标签 / 域名 + 摘要),行尾悬停现出两颗快捷钮,点开在下面
 * 多出一块详情。
 *
 * 快捷钮与行钮是**兄弟**不是父子:钮里套钮是非法 DOM。它们住在 `ui/Reveal` 里,
 * 作用域是整条来源(行 + 详情)—— 鼠标在详情上时它们也在。
 */
function SourceRow({
  t,
  episode,
  source,
  ctx,
  toggle,
}: {
  t: TFn
  episode: ResearchEpisodeModel
  source: ResearchSource
  ctx: BlockCtx
  toggle: (open: boolean) => boolean
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useFlipHeight(boxRef, open ? 'open' : 'closed', FLIP)
  const copy = useCopyFeedback(t)

  return (
    <div
      ref={boxRef}
      className={s.source}
      data-source-open={open || undefined}
      data-source-read={isRead(source) || undefined}
      {...REVEAL_SCOPE}
    >
      <Fold open={open} onOpenChange={(next) => setOpen(toggle(next))}>
        <div className={s.sourceRow}>
          {/* 整条地址走 `ui/Tooltip`:行上画的是标题与域名,完整 URL 只在悬停时说。 */}
          <Tooltip content={source.url}>
            <FoldTrigger className={s.sourceFace}>
              <Favicon domain={source.domain} size="md" />
              <span className={s.sourceMain}>
                <span className={s.sourceLine1}>
                  <span className={s.sourceTitle}>{source.title ?? source.url}</span>
                  {source.openStatus === 'ok' && (
                    <span className={s.readTag}>{t('chat.research.read')}</span>
                  )}
                  {source.openStatus === 'failed' && (
                    // 「打开过但没读到正文」是真实且常见的结局(反爬 / 无正文)。不说的话,
                    // 这一行看起来就像模型读过这一页 —— 那是屏幕在替它说谎。
                    <span className={s.sourceFailed}>{t('chat.research.openFailed')}</span>
                  )}
                </span>
                <span className={s.sourceLine2}>
                  <span className={s.sourceDomain}>{source.domain}</span>
                  {source.excerpt && <span className={s.sourceSnippet}>{source.excerpt}</span>}
                </span>
              </span>
            </FoldTrigger>
          </Tooltip>
          <Reveal className={s.sourceActs}>
            <IconButton
              size="xs"
              icon={OpenIcon}
              label={t('chat.research.openInBrowser')}
              onClick={() => void openSourceUrl(source.url)}
            />
            <IconButton
              size="xs"
              icon={copy.copied ? CheckIcon : CopyIcon}
              label={t(copy.copied ? 'common.copied' : 'chat.research.copyLink')}
              onClick={() => copy.run(source.url)}
            />
          </Reveal>
        </div>
        <LazyFoldBody open={open}>
          <SourceDetail t={t} episode={episode} source={source} ctx={ctx} toggle={toggle} />
        </LazyFoldBody>
      </Fold>
    </div>
  )
}

/**
 * 来源详情:这一页的摘录(命中词加粗)、完整地址、看原始调用。
 *
 * 人点一条来源想看的是「这一页说了什么」,不是「工具吐了什么」—— 所以工具原始输出
 *(C1 的 `ToolDrawer`,与工具卡逐字同一件)降到最后一个动作后面,排查时仍找得到。
 * 打开 / 复制两颗在行尾那一组里(Reveal 的作用域覆盖这块详情),这里不再摆第二份。
 */
function SourceDetail({
  t,
  episode,
  source,
  ctx,
  toggle,
}: {
  t: TFn
  episode: ResearchEpisodeModel
  source: ResearchSource
  ctx: BlockCtx
  toggle: (open: boolean) => boolean
}) {
  const [raw, setRaw] = useState(false)
  const step = sourceStep(episode, source)
  // 与工具行同一条:结局没定下来就不给按钮。按得动却什么也不发生的钮比没有钮更费人。
  const hasRaw = step !== undefined && EXPANDABLE_STATUSES.has(step.row.status)

  return (
    <div className={s.detail}>
      {source.excerpt && (
        <p className={s.excerpt}>
          <MarkedText text={source.excerpt} marks={source.excerptMarks} />
        </p>
      )}
      <span className={s.detailUrl}>{source.url}</span>
      {hasRaw && (
        <Fold open={raw} onOpenChange={(next) => setRaw(toggle(next))}>
          {/* 行内微型文字动作(无边无底)= 结构件第三类;行为照样归 `ui/Fold`。 */}
          <FoldTrigger as="span" className={s.detailAct}>
            <RawIcon className={s.detailActIcon} strokeWidth={2} aria-hidden="true" />
            {t('chat.research.rawCall')}
          </FoldTrigger>
          <LazyFoldBody open={raw}>
            <ToolDrawer call={step.call} ctx={ctx} />
          </LazyFoldBody>
        </Fold>
      )}
    </div>
  )
}

/** 按下标画粗体 —— 摘录是外部文本,永远不当 HTML 渲染。 */
function MarkedText({
  text,
  marks,
}: {
  text: string
  marks: ResearchSource['excerptMarks']
}) {
  if (!marks || marks.length === 0) return <>{text}</>
  const out: ReactNode[] = []
  let at = 0
  for (const [start, end] of marks) {
    if (start < at) continue
    if (start > at) out.push(text.slice(at, start))
    out.push(
      <mark className={s.hit} key={start}>
        {text.slice(start, end)}
      </mark>,
    )
    at = end
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

interface CopyFeedback {
  copied: boolean
  run: (text: string) => void
}

/**
 * 复制 + 就地反馈(⧉ 换 ✓ 一拍,`COPY_FEEDBACK_MS` 后还原;读屏播报走
 * `copyPathAnnouncing`)。
 */
function useCopyFeedback(t: TFn): CopyFeedback {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const run = useCallback(
    (text: string) => {
      void copyPathAnnouncing(text, t).then((ok) => {
        setCopied(ok)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
      })
    },
    [t],
  )
  return { copied, run }
}

/** 组头:署了名的说查询词,未署名的说「直接打开」(不给它编一个查询词)。 */
function groupHeadText(t: TFn, group: ResearchQueryGroup): string {
  return group.query === undefined ? t('chat.research.direct') : group.query
}
