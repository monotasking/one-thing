import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useStageStore } from '../stage/store'
import { clampFloatRect, resizeFrom, snapSideAt } from '../stage/transitions'
import { panelIdOf } from '../stage/panel-ref'
import { setSnapSide } from './snap-hint'
import { useWorkbenchStore } from '../workbench/store'
import { floatRegion } from '../workbench/regions'
import { PaneTree } from '../workbench/PaneTree'
import { contentKindOf, refId } from '../workbench/kinds'
import { leafCount } from '../workbench/layout'
import { leavesOf } from '../workbench/tree'
import { useLiveTitleStore } from '../stage/live-title'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import { Menu, MenuItem, MenuSection } from '../ui/Menu'
import { IconButton } from '../ui/IconButton'
import { Maximize2, Pin, X } from './icons'
import { exitMs } from './motion'
import { SHELF_SIDE_CHOICES } from '../stage/types'
import type { PaneHostChrome } from '../workbench/PaneLeaf'
import type { PaneNode } from '../workbench/tree'
import type { FloatRect, ShelfSide } from '../stage/types'
import type { ResizeDir } from '../stage/transitions'
import s from './FloatWindow.module.css'

/** 八个把手:四边四角。角在数组末尾 = DOM 里靠后 = 画在边之上,所以角优先抢得到指针。 */
const HANDLES: Array<{ dir: ResizeDir; cls: string }> = [
  { dir: 'n', cls: s.hN },
  { dir: 's', cls: s.hS },
  { dir: 'w', cls: s.hW },
  { dir: 'e', cls: s.hE },
  { dir: 'nw', cls: s.hNW },
  { dir: 'ne', cls: s.hNE },
  { dir: 'sw', cls: s.hSW },
  { dir: 'se', cls: s.hSE },
]

interface WindowProps {
  id: string
  /** 在 floatOrder 里的次序;末位最上,所以 z 就是「基准档 + 次序」。 */
  order: number
  leaving?: boolean
}

/**
 * 一扇浮窗。它是「布局内的 fixed 层」,不走 portal —— portal 是给菜单那种
 * 会被祖先包含块坑到的浮层用的;浮窗自己就是层,没有祖先能坑它。
 *
 * 拖移与缩放遵守跟手定律:过程中零过渡、逐帧写**本地** state,松手才落 store。
 * 钳制两处共用 transitions 里的同一个纯函数,所以「拖着看到的」与「存下来的」逐像素相同。
 *
 * ── W4:身子是一棵树,**标题栏就是它根叶的 tab 条** ────────────────────────
 * 设计 §2.2 的原话:「浮窗的标题栏**就是**它里面那棵树根叶的 tab 条(与浏览器
 * 一致:tab 长在窗口檐上)」。所以这只文件里**没有第二条 40px 的檐** —— 从前那条
 * `<header>`(图标 + `HostTitle` + 三颗钮)整件退役,它的三颗钮改挂进根叶那条檐的
 * 右端(`PaneHostChrome.actions`),拖窗那一下改由那条檐的空白处发起
 * (`onChromePointerDown`)。
 *
 * 于是从前那条判例(09-01「浮窗双檐」:查看器自带一条檐与浮窗檐上下叠着,
 * 两条 40px 白占掉 520 高窗口的 15%)在**结构上**不可能再发生:这扇窗一共只有
 * 一条带子,而它是树自己那条。
 *
 * **那颗 ✕ 的语义也随之定死**:关这扇窗 = 把里面的 tab **全部隐藏**(设计 §2.2),
 * 不是关闭 —— 窗子没了,内容还在隐藏表里,「隐藏的标签 ⋯」点得回来。
 *
 * ── 状态表 ①:生命周期 ──────────────────────────────────────────────────
 *   挂载    `float:<id>` 那棵树长出来(`placeAs(id, {kind:'float'})` / 撕出来)
 *   首载    **不画载入态**(树同步已知);内容自己说
 *   换宿主  吸到边上:树整棵搬进 `edge:<side>`,这扇窗随之卸载
 *   卸载    树空了(全部隐藏 / 全部关掉 / 搬走);离场动画多留一帧(见 `FloatLayer`)
 *
 * ── 状态表 ②:UI 生命状态 ───────────────────────────────────────────────
 *   单 tab / 多 tab / 有预览 / 有隐藏 —— **全归那条檐**(`LeafStrip` / `PaneLeaf`)
 *   分屏     树自己的事(`PaneTree` 画杆)
 *   拖移 / 缩放  逐帧本地 state,零过渡
 *   吸附预示 拖到边缘热带时 `setSnapSide`
 *   离场     `leaving` 那一帧(`--kf-float-in` 的反向)
 *
 * ── 状态表 ③:UI 交互状态 ───────────────────────────────────────────────
 *   八个把手  不可见热区(只给光标与命中)
 *   三颗钮    随 `ui/IconButton`(md 档)
 *   檐空白    按下 = 拖窗;按在 tab / 钮上让开(判据在 `isDragBlank`)
 */
function FloatWindow({ id, order, leaving }: WindowProps) {
  const t = useT()
  const region = floatRegion(id)
  const tree = useWorkbenchStore((st) => st.regions[region])
  const stored = useStageStore((st) => st.floats[id])
  const focusFloat = useStageStore((st) => st.focusFloat)
  const moveFloat = useStageStore((st) => st.moveFloat)
  const resizeFloat = useStageStore((st) => st.resizeFloat)
  const openAs = useStageStore((st) => st.openAs)
  const floatToEdge = useStageStore((st) => st.floatToEdge)
  const closeFloat = useStageStore((st) => st.closeFloat)
  const titles = useLiveTitleStore((st) => st.titles)

  // 拖拽过程中的实时矩形。松手清空,渲染就自动回到 store 那份(两者此刻相等)。
  const [live, setLive] = useState<FloatRect | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const liveRef = useRef<FloatRect | null>(null)
  /*
   * 钉边菜单贴着**那颗钮**的下缘开,所以要能**在任意时刻**量到那颗钮的矩形。
   * 刻意不改成「在 onPointerDown 里记一次」:那条路键盘按 ↵ 走不到,
   * 菜单会开在 0,0。
   */
  const pinRef = useRef<HTMLButtonElement>(null)

  /*
   * **离场那一帧画的是它最后那一份内容**(W4)。关一扇窗 = 树整棵没了
   * (`hideRegion` 把区域删掉),而出场动画要这扇窗在 DOM 里再活 `exitMs()`;
   * 不留这一份的话,`FloatLayer` 手上那个「离场副本」会画成空 —— 屏幕上就是
   * 「窗子瞬间消失,再挂一个空壳」,正是 08-30 那条「消失→闪现→再消失」的同型。
   *
   * 渲染期写 ref 与 `FloatLayer` 里那句 `prev.current = order` 同一条:
   * 它只是「把上一帧记住」,不参与本次渲染的判据。
   */
  const lastTree = useRef<PaneNode | undefined>(undefined)
  if (tree) lastTree.current = tree
  const shownTree = tree ?? (leaving ? lastTree.current : undefined)
  const rect = live ?? stored
  /**
   * 这扇窗此刻在显示什么 —— **无障碍名**用它。身份两半合一的判据整件在
   * `LeafStrip.tabSpecOf`(活的盖静的),这里只取根叶活动那一格的那句话。
   */
  const title = useMemo(() => activeTitleOf(shownTree, titles) ?? t('float.window'), [shownTree, titles, t])
  /** 「钉到边 / 放大」那两颗只对**瓦**说得通(见 `placement.ts` 的判词)。 */
  const activeItemId = useMemo(() => activeItemOf(shownTree), [shownTree])

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>, dir: ResizeDir | null) => {
      if (e.button !== 0 || !rect) return
      e.preventDefault()
      focusFloat(id)
      const el = e.currentTarget
      // 捕获失败(如 pen 抬笔竞态、合成指针)不放弃拖拽:capture 只是锦上添花,
      // 监听本来就挂在元素上,丢 capture 最多丢"指针滑出元素后的帧"。
      try { el.setPointerCapture(e.pointerId) } catch { /* 不阻断 */ }
      const from = rect
      const startX = e.clientX
      const startY = e.clientY
      const vp = { w: window.innerWidth, h: window.innerHeight }
      // 只有「拖着整扇窗走」才谈吸附;拉把手改身量与落到哪条边无关。
      let landing: ShelfSide | null = null

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        const next = clampFloatRect(
          dir ? resizeFrom(from, dir, dx, dy) : { ...from, x: from.x + dx, y: from.y + dy },
          vp,
        )
        liveRef.current = next
        setLive(next)
        if (dir) return
        landing = snapSideAt({ x: ev.clientX, y: ev.clientY }, vp)
        setSnapSide(landing)
      }
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        const final = liveRef.current
        liveRef.current = null
        setLive(null)
        setSnapSide(null)
        if (!final) return
        if (dir) {
          resizeFloat(id, final)
          return
        }
        // 松手在热带里 = 钉上去(浮窗塌进架子,那一次形变走 --dur-enter);
        // 不在热带里就照常落位 —— 高亮散了不改变松手的语义。
        if (landing) floatToEdge(id, landing)
        else moveFloat(id, final.x, final.y)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    },
    [rect, id, focusFloat, moveFloat, resizeFloat, floatToEdge],
  )

  /**
   * 按在檐上 = 拖这扇窗 —— 但**按在 tab 或钮上让开**。
   * 判据写成一句话在这里,而不是散在两个处理器里:那两类都是「这一下有别的意思」。
   */
  const onChromePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!isDragBlank(e.target)) return
      begin(e, null)
    },
    [begin],
  )

  const host = useMemo<PaneHostChrome>(
    () => ({
      onChromePointerDown,
      actions: (
        <>
          {/* 三颗全部消费 `ui/IconButton`(md 档 = 28×28)。`onPointerDown` 那一下
            * 仍要拦住:不拦,按住钮就等于按住檐在拖窗。 */}
          <IconButton
            ref={pinRef}
            icon={Pin}
            size="md"
            label={t('stage.pinToEdge')}
            disabled={activeItemId === null}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              const r = pinRef.current?.getBoundingClientRect()
              if (r) setMenu({ x: r.left, y: r.bottom })
            }}
          />
          <IconButton
            icon={Maximize2}
            size="md"
            label={t('float.toStage')}
            disabled={activeItemId === null}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => activeItemId && openAs(activeItemId, { kind: 'stage' })}
          />
          <IconButton
            icon={X}
            size="md"
            label={t('float.close')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => closeFloat(id)}
          />
        </>
      ),
    }),
    [onChromePointerDown, t, activeItemId, openAs, closeFloat, id],
  )

  if (!shownTree || !rect) return null
  const multi = leafCount(shownTree) > 1

  /*
   * **每扇窗一格 `layer`**(09-02 R1)。它自己不认 Esc —— 收窗那件事在退层链里
   * (`stage/transitions.escapeTargetOf`:盖 → 舞台 → 最上面那扇浮窗),而退层链
   * 是响应链**根**的 `onEscape`。这一格回答的是「焦点此刻在哪扇窗里」,于是
   * 窗里开出来的菜单在树上是这扇窗的孩子(一下 Esc 先关菜单),窗关掉时焦点
   * 结构性地回到它的父。
   */
  return (
    <FocusScope scope="float-layer" owner={id}>
      {({ scopeProps }) => (
        <section
          {...scopeProps}
          className={leaving ? `${s.win} ${s.leaving}` : s.win}
          style={{
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.w}px`,
            height: `${rect.h}px`,
            zIndex: `calc(var(--z-float) + ${Math.max(order, 0)})`,
          }}
          role="dialog"
          aria-label={title}
          onPointerDown={() => focusFloat(id)}
        >
          {/*
            身 = 这扇窗那棵树。**标题栏就是它根叶那条檐**(设计 §2.2)——
            所以这里没有 `<header>`:那条带子由 `PaneLeaf` 画,窗自己那三颗钮
            与拖窗手势经 `host` 挂上去。
          */}
          <div
            className={s.body}
            data-float-body={id}
            data-pane-region={region}
            data-pane-multi={multi || undefined}
          >
            <PaneTree node={shownTree} host={host} />
          </div>

          {HANDLES.map((h) => (
            <div
              key={h.dir}
              className={`${s.handle} ${h.cls}`}
              aria-hidden="true"
              onPointerDown={(e) => begin(e, h.dir)}
            />
          ))}

          {menu && activeItemId && (
            <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={t('stage.pinToEdge')}>
              <MenuSection>{t('stage.pinToEdge')}</MenuSection>
              {SHELF_SIDE_CHOICES.map((c) => (
                <MenuItem
                  key={c.value}
                  onClick={() => {
                    floatToEdge(activeItemId, c.value)
                    setMenu(null)
                  }}
                >
                  {t(c.labelKey)}
                </MenuItem>
              ))}
            </Menu>
          )}
        </section>
      )}
    </FocusScope>
  )
}

/**
 * 这一下按在檐的**空白**上吗。tab(`role="tab"`)与钮各有各的意思,按在它们上面
 * 不该顺手把窗拖走 —— 这正是从前 `<header>` 上那句 `closest('button')` 的同一条
 * 判据,只是 tab 在 `ui/Tabs` 里不是 `<button>`(ARIA 逼出来的:tablist 的合法
 * 子成员只有 tab),所以要多问一句 `[role="tab"]`。
 */
function isDragBlank(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true
  return target.closest('button,[role="tab"]') === null
}

/** 根叶此刻活动那一格的标题(活的盖静的)。答不出就交回 null。 */
function activeTitleOf(
  tree: PaneNode | undefined,
  titles: Record<string, { text: string }>,
): string | null {
  const leaf = tree ? leavesOf(tree)[0] : null
  const ref = leaf?.tabs[leaf.active]
  if (!ref) return null
  return titles[refId(ref)]?.text ?? contentKindOf(ref.kind)?.title(ref).text ?? ref.key
}

/** 根叶此刻活动那一格如果是块瓦,答它的瓦 id。 */
function activeItemOf(tree: PaneNode | undefined): string | null {
  const leaf = tree ? leavesOf(tree)[0] : null
  const ref = leaf?.tabs[leaf.active]
  return ref ? panelIdOf(ref) : null
}

/**
 * 浮窗层:把 floatOrder 铺成一叠窗。它多做的唯一一件事是「留一帧给出场动画」——
 * 与 StageOverlay 的 held 同一条判例:形态机不该知道动画的存在。
 */
export function FloatLayer() {
  const order = useStageStore((st) => st.floatOrder)
  const [leaving, setLeaving] = useState<string[]>([])
  const prev = useRef<string[]>(order)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  /*
   * 「刚离场的」在**渲染期同步**导出,不等 effect(08-30 用户报障的真因):
   * 用 effect 检测晚一个提交 —— order 丢掉 id 的那一帧真窗已经卸载,离场副本
   * 下一帧才挂上,肉眼就是「消失 → 再闪现 → 再消失」,而且旧写法的副本用的是
   * `leaving-${id}` 这个**新 key** = Exposé 那样的重面板整棵重挂一遍。
   * 渲染期 setState(同组件)会让 React 在提交前重跑本次渲染 —— 这正是官方的
   * 「从 props 派生 state」形状,窗因此一帧都不缺席。
   */
  /*
   * 动效档「无」时**根本不进离场名单**:没有出场动画要播,也就没有理由让一扇
   * 已经关掉的窗在 DOM 里再活 120ms。关掉 = 这次提交里就没有它。
   * (排一个 0ms 的定时器也能到,但那要多等一个宏任务 —— 与 StageOverlay 同一条。)
   */
  if (prev.current !== order) {
    const newlyGone = prev.current.filter((id) => !order.includes(id) && !leaving.includes(id))
    prev.current = order
    if (newlyGone.length > 0 && exitMs() > 0) setLeaving((l) => [...l, ...newlyGone])
  }

  // 每个离场 id 各自计时;又被打开的当场从离场名单摘掉(它回到 order 那一半去画)。
  useEffect(() => {
    for (const id of leaving) {
      if (order.includes(id)) {
        const timer = timers.current.get(id)
        if (timer) clearTimeout(timer)
        timers.current.delete(id)
        setLeaving((l) => l.filter((x) => x !== id))
        continue
      }
      if (timers.current.has(id)) continue
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id)
          setLeaving((l) => l.filter((x) => x !== id))
          // 现问一次动效档:「无」档下 exitMs() = 0,关窗即卸载,不留空壳。
        }, exitMs()),
      )
    }
  }, [leaving, order])
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), [])

  /*
   * 离场窗与在场窗必须并进**同一个数组**再渲染:JSX 里两个并排的 `{array}` 是两个
   * 子槽,key 只在各自槽内认人 —— id 跨槽挪动照样卸载重挂(本测试修前抓的第二个
   * 坑)。一个数组一个 key 命名空间,id 从「在场」挪去「离场」只是位置变了,
   * 实例与 DOM 原封不动,出场动画播在活实例上。两半永远不含同一个 id
   * (filter 保证),不会撞 key。
   */
  const shown = [
    ...order.map((id, i) => ({ id, at: i, leaving: false })),
    ...leaving
      .filter((id) => !order.includes(id))
      .map((id, i) => ({ id, at: order.length + i, leaving: true })),
  ]
  return (
    <>
      {shown.map((w) => (
        <FloatWindow key={w.id} id={w.id} order={w.at} leaving={w.leaving} />
      ))}
    </>
  )
}
