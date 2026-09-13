import { Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useT, type MessageKey, type TFn } from '../../../i18n'
import { ButtonBase } from '../../../ui/ButtonBase'
import { IconButton } from '../../../ui/IconButton'
import { Menu, MenuItem } from '../../../ui/Menu'
import { resolveIcon } from '../../../components/icons'
import type { BlockModel } from '../../model/blocks'
import type { BlockAction, BlockChrome, BlockCtx, BlockDef } from '../registry'
import { BlockErrorBoundary } from './BlockErrorBoundary'
import { SourceView } from './SourceView'
import { ZoomOverlay } from './ZoomOverlay'
import { COPY_FEEDBACK_MS } from '../../../components/motion'
import { announce } from '../../../ui/a11y/live-region'
import { blockActionLabelKey, isBlockActionRunnable, runBlockAction, type ZoomContent } from './actions'
import { clampMeasurer } from './clamp-measurer'
import { readBlockLoader } from './loader'
import { blockSourceText } from './source'
import s from './BlockShell.module.css'

const MoreIcon = resolveIcon('Ellipsis')

/** 筛过之后的一格动作:动作本身 + 它在字典里的标签键。 */
interface LabelledAction {
  action: BlockAction
  labelKey: MessageKey
}

/**
 * 块的壳 —— **公共的六件事只在这里实现一次**(铁律 3)。
 *
 * 六件:① 单块错误边界 ② 懒加载 Suspense ③ 檐(左 id/meta · 中 title · 右动作组)
 * ④ 动作组(≤2 露出 + ⋯ 菜单)⑤ 块内横滚 ⑥ 限高折叠。块渲染器以**声明**换取
 * 这六件能力(chrome / actions / streaming / loader),自己一行都不写。
 *
 * 这条分界买到的是横切规范的**结构保证**:UI 六轮定下的「动作常显住檐右端」
 * 「词表统一」「块内不许自己横滚」因此天然全局成立,不靠每个块的作者自觉 ——
 * 新块的作者根本没有做错的机会,因为那些代码不在他手里。
 *
 * ── 两种呈现,两种壳 ─────────────────────────────────────────────────
 * `object`(代码 / 表 / 图 / diff / 兜底)= 一件东西:有檐、有边、能横滚、能折叠。
 * `flow`(段落 / 标题 / 引用)= 纸上的一段字:壳**一个 DOM 节点都不加**,只给它
 * 错误边界与懒加载。这不是省事 —— 多包一层 div 会当场改掉它在消息 flex 列里的
 * 布局参与方式(gap 归属、外边距合并),而聊天纸面的排版是逐像素定过的。
 */
export function BlockShell({
  def,
  model,
  ctx,
}: {
  def: BlockDef
  model: BlockModel
  ctx: BlockCtx
}) {
  const t = useT()
  const [sourceOpen, setSourceOpen] = useState(false)
  const toggleSource = useCallback(() => setSourceOpen((open) => !open), [])
  /*
   * 放大浮层是**壳的状态**,和「查看源码」同一格:块声明动作,壳决定屏幕上发生什么。
   * 这一格装的是 `ZoomContent`(矢量 / 位图二选一)而不是一段 SVG 字符串 ——
   * 壳里因此没有一处判「这是哪一种块」,判的是「这次放大拿到的是哪一种内容」。
   */
  const [zoom, setZoom] = useState<ZoomContent | null>(null)
  const closeZoom = useCallback(() => setZoom(null), [])

  const body = sourceOpen ? (
    <SourceView source={blockSourceText(model)} />
  ) : (
    <BlockBody def={def} model={model} ctx={ctx} />
  )

  const guarded = (
    <BlockErrorBoundary
      where={`block:${model.kind}@${ctx.messageId}`}
      fallback={(error) => <BlockFailure t={t} model={model} error={error} />}
    >
      <Suspense fallback={<div className={s.skeleton} aria-hidden="true" />}>{body}</Suspense>
    </BlockErrorBoundary>
  )

  if (def.presentation === 'flow') return guarded

  const chrome = def.chrome?.(model)
  // 露出条件两条同时成立:有执行器、有标签。在这里一次性筛成「动作 + 它的标签键」,
  // 后面画的时候就不必再判一次(也就不必为「筛过了所以一定有」写一个类型断言)。
  const actions = (def.actions?.(model, ctx) ?? []).flatMap((action) => {
    const labelKey = blockActionLabelKey(action, sourceOpen)
    return labelKey && isBlockActionRunnable(action) ? [{ action, labelKey }] : []
  })

  /*
   * `data-prose="object"` 是**节奏表的钩子**(表在 content/ChatStream.module.css):
   * 物件块上下留白比文字节奏多一档(--pr-obj)。它挂在**壳**上而不是各块自己身上,
   * 正是壳这条分界的意义 —— 「object 该留多少白」是公共的第七件事,块作者
   * 没有做错的机会。flow 那一支不挂:壳在那条路上一个 DOM 节点都不加,
   * 节奏钩子由块自己的根元素报(见 Paragraph / Heading / List / Quote)。
   */
  return (
    <section
      className={s.block}
      data-block-kind={model.kind}
      data-prose="object"
      /*
       * **几何政策上到 DOM**(R4b)。`reserve` = 这一型在流式期间先立骨架、内容后到,
       * 壳因此要给它「内容后到不许把下面踹一脚」的那几条(见 BlockShell.module.css
       * 的 `[data-geometry='reserve']` 一段)。政策由型自报(五问的第五问),
       * 壳只负责把它变成一个选择器 —— 壳里一处 kind 名都不多写。
       */
      data-geometry={def.stream.geometry}
    >
      {/* 檐:有 chrome 声明或有动作就画 —— 动作要有家(空 caption 的表格也留着檐)。 */}
      {(chrome || actions.length > 0) && (
        <header className={s.eave}>
          <span className={s.ident}>
            {chrome?.id && <span className={s.id}>{chrome.id}</span>}
            {chrome?.meta && <span className={s.meta}>{chrome.meta}</span>}
          </span>
          {chrome?.stat && <DiffStat stat={chrome.stat} />}
          {chrome?.title && <span className={s.title}>{chrome.title}</span>}
          {actions.length > 0 && (
            <BlockActions
              t={t}
              actions={actions}
              front={def.frontActions ?? 2}
              onToggleSource={toggleSource}
              onZoom={setZoom}
            />
          )}
        </header>
      )}
      <ClampedBody t={t}>{guarded}</ClampedBody>
      {zoom !== null && <ZoomOverlay content={zoom} onClose={closeZoom} />}
    </section>
  )
}

/**
 * 增删读数 —— 两枚色字,不是徽章。
 *
 * 徽章是「一件东西」(有底、有边、有内边距),而「+12 −3」是一个**读数**:它和
 * 左边的文件路径同一号字、同一条基线,只有颜色不同。定稿里这条差别是刻意的 ——
 * 檐上已经有一件东西(卡片本身),再往上摞小方块会让檐变成工具条。
 *
 * 零永远照说(`+0 −0` 是真值,不是空)。删号用真减号 `−` 而不是 hyphen:
 * 与工具行的 `chat.tool.diffStat` 是同一个字形,两处读数不该长得不一样。
 */
function DiffStat({ stat }: { stat: NonNullable<BlockChrome['stat']> }) {
  return (
    <span className={s.stat}>
      <span className={s.statAdd}>+{stat.add}</span>
      <span className={s.statDel}>−{stat.del}</span>
    </span>
  )
}

/**
 * 本体 + 懒加载闸。
 *
 * 拉加载的那一下必须发生在 Suspense **里面**的组件里(抛 promise 的是子组件,
 * 接住的是上面那层 Suspense),所以它自成一个组件而不是壳里的一行。
 */
function BlockBody({ def, model, ctx }: { def: BlockDef; model: BlockModel; ctx: BlockCtx }) {
  readBlockLoader(def)
  const Component = def.Component
  return <Component model={model} ctx={ctx} />
}

/**
 * 降级物:源码 + 一行说明。
 *
 * 说明只有一句人话 + 后端/运行时说的那句原话 —— 不总结、不改写(与错误消息卡
 * 同一条纪律)。技术细节要看堆栈的人去崩溃日志里看,那里记全了。
 */
function BlockFailure({ t, model, error }: { t: TFn; model: BlockModel; error: Error }) {
  return (
    <div className={s.failure} role="note">
      <span className={s.failureLine}>
        {t('block.renderFailed')}
        <span className={s.failureReason}>{error.message}</span>
      </span>
      <SourceView source={blockSourceText(model)} />
    </div>
  )
}

/**
 * 动作组:前两个露出,其余进 ⋯ 菜单。
 *
 * 静默 text-4,悬到才亮 —— 檐上的东西不跟内容抢注意力(六轮定稿)。
 */
function BlockActions({
  t,
  actions,
  front: budget,
  onToggleSource,
  onZoom,
}: {
  t: TFn
  actions: LabelledAction[]
  /** 露出预算(块可以把它压到 1 —— 图卡定稿只留「放大」)。 */
  front: 1 | 2
  onToggleSource: () => void
  onZoom: (content: ZoomContent) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /**
   * 复制的就地反馈(08-31 拍板:不走通知)—— 按下的那颗钮换字说「已复制 /
   * 没能复制」,`COPY_FEEDBACK_MS` 后换回。键 = 钮的稳定 key;一次只记最近一颗
   * (连按两颗不同的复制钮,前一颗的读认让位给后一颗,无损)。
   */
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const front = actions.slice(0, budget)
  const rest = actions.slice(budget)

  const run = (action: BlockAction, key?: string) => {
    void runBlockAction(action, { toggleSource: onToggleSource, openZoom: onZoom }).then((ok) => {
      if (ok === undefined) return
      // 读屏两路都播报(菜单里的复制钮点完菜单就没了,视觉反馈无处可长,
      // 播报是它唯一的回音);视觉就地换字只给还留在屏上的那颗钮。
      announce(t(ok ? 'common.copied' : 'common.copyFailed'))
      if (!key) return
      setCopied({ key, ok })
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    })
  }

  return (
    <span className={s.actions}>
      {front.map((entry, index) => {
        const key = `${entry.action.verb}:${index}`
        const fed = copied?.key === key
        return (
          /*
           * 三类判的第三类:**檐上的静默微型动作**(fs-micro / text-4 / 无边框
           * 无底),视觉本该定制 —— 与批 3 把「加载更多」判进基座是同一形,
           * 不是 `ui/Button` 那种 28 高带描边的文字钮。所以皮肤留在本地,
           * 清 UA 归 `ui/ButtonBase`。
           */
          <ButtonBase
            key={key}
            className={s.action}
            data-copied={fed ? '' : undefined}
            onClick={() => run(entry.action, key)}
          >
            {fed ? t(copied.ok ? 'common.copied' : 'common.copyFailed') : t(entry.labelKey)}
          </ButtonBase>
        )
      })}
      {rest.length > 0 && (
        /*
         * 这一颗是**真图标钮**(⋯),所以它归 `ui/IconButton` —— 名字、提示、
         * 四态配方与几何全在库件里,本地不再挂 `.action`(那份皮肤是给文字钮的)。
         * `e.currentTarget` 拿得到:批 3.5 起 IconButton 的 onClick 收事件。
         */
        <IconButton
          icon={MoreIcon}
          size="xs"
          label={t('block.actions')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left, y: r.bottom })
          }}
        />
      )}
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={t('block.actions')}>
          {rest.map((entry, index) => (
            <MenuItem
              key={`${entry.action.verb}:${index}`}
              onClick={() => {
                run(entry.action)
                setMenu(null)
              }}
            >
              {t(entry.labelKey)}
            </MenuItem>
          ))}
        </Menu>
      )}
    </span>
  )
}

/**
 * 块内横滚 + 限高折叠。
 *
 * 横滚是 CSS 的事(`overflow-x:auto` + `overscroll-behavior-x:contain` —— 后者不是
 * 装饰:少了它,块横向滚到头会把滚动传给整条聊天流,手感上是「一划就飞走」)。
 * **只锁横轴**:纵向另有 `overflow-y:hidden`,折叠态压根不是滚动容器,滚轮照常
 * 滚页面(写成双轴简写会把滚轮吞在块上,病历在 BlockShell.module.css 的 .body)。
 *
 * 限高折叠要量:超了才画渐隐和展开钮,没超一个像素都不该动。量的是
 * `scrollHeight > clientHeight`,在布局阶段做(useLayoutEffect),所以用户看不到
 * 「先出现展开钮再消失」的一帧。jsdom 里没有排版、两个值都是 0,于是单测里
 * 永远不折叠 —— 这正确:测试要验的是块画出来了什么,不是浏览器怎么排版。
 *
 * **渐隐与展开钮是同一格 `overflows` 的两个出口**(09-02 修:从前渐隐无条件写在
 * `.body` 上,于是一行的短块也被雾掉底下 24px —— 屏幕上说「下面还有」而其实没有)。
 * 判据只有这一处;CSS 那一侧的病历写在 `BlockShell.module.css` 的 `.bodyClamped`。
 *
 * ── 内容会**后来才长高**,所以量一次不够(P3 真机抓到) ──────────────────
 * 图要等 mermaid 渲完、代码要等 shiki 拉到,这两下都发生在块自己的 state 里,
 * 外面这一层的 `children` 引用一动不动 —— 于是只在挂载时量的话,一张 414px 高的图
 * 会被 320px 的钳子静静切掉底下四分之一,而展开钮**永远不出现**(真机读数:
 * scrollHeight 414 / clientHeight 320 / 无展开钮)。
 *
 * 修法是给内容一个**跟着它长的盒子**(下面那层 div)并用 ResizeObserver 盯着它。
 * 盯外面那层没用:它被 max-height 钳着,高度从头到尾就是那个数,永远不触发。
 * 内层是块级、宽度自动,与「内容直接当 body 的子节点」在排版上等价(长行照旧
 * 溢出到外层去横滚),所以它是纯观测用的一层,不改任何块的样子。
 *
 * ── 09-03:量尺搬进 `clamp-measurer`,这里只剩「登记 / 注销」 ────────────────
 * 从前这条 effect 的依赖表里带着 `children`(ReactNode,父组件每渲一次就是新引用),
 * 于是每一次提交、每一个块都在 commit 里同步读一次 `scrollHeight`(强制排版)
 * 并重建一只 RO —— 切一次常规档会话 `measure` self **59.5ms**,是整份 profile 里
 * `/src/` 的第一热点。现在:全壳一只观察者、一批只排一次版、**RO 的首次回调就是
 * 初量**,所以依赖表只剩 `expanded`。内容后来才长高照旧管得住(内层盒子在长,
 * 那正是它存在的理由),病历与代价逐条写在 `clamp-measurer.ts` 文件头。
 */
function ClampedBody({ t, children }: { t: TFn; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    const box = inner.current
    if (!el || !box || expanded) return
    // 没有 ResizeObserver(jsdom)= 量一次就走。那里两个值都是 0,本来就永不折叠。
    if (typeof ResizeObserver === 'undefined') {
      setOverflows(el.scrollHeight > el.clientHeight + 1)
      return
    }
    // 量出同一个值时 setState 会自己短路,所以「每次内容变动都量一次」不会成环。
    clampMeasurer.observe(box, el, setOverflows)
    return () => clampMeasurer.unobserve(box)
  }, [expanded])

  /*
   * 三档一处产地:展开(撤钳子)/ 裁断中(挂遮罩)/ 没裁到(什么都不挂)。
   * 遮罩与展开钮读的是**同一格** `overflows` —— 它们说的本来就是同一件事
   * 「下面还有」,分成两个判据就会出现「雾着却没有钮」(09-02 那条报障的形)。
   */
  const bodyClass = expanded
    ? `${s.body} ${s.bodyExpanded}`
    : overflows
      ? `${s.body} ${s.bodyClamped}`
      : s.body

  return (
    <>
      <div ref={ref} className={bodyClass}>
        <div ref={inner}>{children}</div>
      </div>
      {overflows && (
        /* 与檐上那几颗同判:微型静默文字钮,皮肤本地、清 UA 归基座。 */
        <ButtonBase className={s.expand} onClick={() => setExpanded((v) => !v)}>
          {t(expanded ? 'block.collapse' : 'block.expand')}
        </ButtonBase>
      )}
    </>
  )
}
