import { Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useT, type MessageKey, type TFn } from '../../../i18n'
import { Menu, MenuItem } from '../../../ui/Menu'
import { resolveIcon } from '../../../components/icons'
import type { BlockModel } from '../../model/blocks'
import type { BlockAction, BlockCtx, BlockDef } from '../registry'
import { BlockErrorBoundary } from './BlockErrorBoundary'
import { SourceView } from './SourceView'
import { blockActionLabelKey, isBlockActionRunnable, runBlockAction } from './actions'
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

  return (
    <section className={s.block} data-block-kind={model.kind}>
      {/* 檐:有 chrome 声明或有动作就画 —— 动作要有家(空 caption 的表格也留着檐)。 */}
      {(chrome || actions.length > 0) && (
        <header className={s.eave}>
          <span className={s.ident}>
            {chrome?.id && <span className={s.id}>{chrome.id}</span>}
            {chrome?.meta && <span className={s.meta}>{chrome.meta}</span>}
          </span>
          {chrome?.title && <span className={s.title}>{chrome.title}</span>}
          {actions.length > 0 && (
            <BlockActions t={t} actions={actions} onToggleSource={toggleSource} />
          )}
        </header>
      )}
      <ClampedBody t={t}>{guarded}</ClampedBody>
    </section>
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
  onToggleSource,
}: {
  t: TFn
  actions: LabelledAction[]
  onToggleSource: () => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const front = actions.slice(0, 2)
  const rest = actions.slice(2)

  const run = (action: BlockAction) => {
    void runBlockAction(action, { toggleSource: onToggleSource })
  }

  return (
    <span className={s.actions}>
      {front.map((entry, index) => (
        <button
          key={`${entry.action.verb}:${index}`}
          type="button"
          className={s.action}
          onClick={() => run(entry.action)}
        >
          {t(entry.labelKey)}
        </button>
      ))}
      {rest.length > 0 && (
        <button
          type="button"
          className={s.action}
          aria-label={t('block.actions')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left, y: r.bottom })
          }}
        >
          <MoreIcon className={s.actionIcon} strokeWidth={1.75} aria-hidden="true" />
        </button>
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
 * 横滚是 CSS 的事(`overflow-x:auto` + `overscroll-behavior:contain` —— 后者不是
 * 装饰:少了它,块滚到头会把滚动传给整条聊天流,手感上是「一划就飞走」)。
 *
 * 限高折叠要量:超了才画渐隐和展开钮,没超一个像素都不该动。量的是
 * `scrollHeight > clientHeight`,在布局阶段做(useLayoutEffect),所以用户看不到
 * 「先出现展开钮再消失」的一帧。jsdom 里没有排版、两个值都是 0,于是单测里
 * 永远不折叠 —— 这正确:测试要验的是块画出来了什么,不是浏览器怎么排版。
 */
function ClampedBody({ t, children }: { t: TFn; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // 重量的时机只有两个:内容换了(children 换引用)、展开态换了。
  // 量出同一个值时 setState 会自己短路,所以「每次内容更新都量一次」不会成环。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [expanded, children])

  return (
    <>
      <div ref={ref} className={expanded ? `${s.body} ${s.bodyExpanded}` : s.body}>
        {children}
      </div>
      {overflows && (
        <button type="button" className={s.expand} onClick={() => setExpanded((v) => !v)}>
          {t(expanded ? 'block.collapse' : 'block.expand')}
        </button>
      )}
    </>
  )
}
