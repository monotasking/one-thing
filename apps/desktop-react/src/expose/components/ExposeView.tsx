import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FocusScope } from '../../focus/FocusScope'
import { useExposeStore } from '../store'
import { useExposeLive } from './use-live'
import type { FocusDir } from '../types'
import { Overview } from './Overview'
import { QuickLook } from './QuickLook'
import { exposeIntentOf } from '../keys'
import { togglePinAndAnnounce } from './pin-announce'
import type { TreeKeyIntent } from '../transitions'
import s from './ExposeView.module.css'

/**
 * 意图 → 一维走位。键名判据在 `expose/keys.ts` 一处(方向 A §3.2 那道禁令),
 * 这里只把它翻成 `moveFocus` 的那两档;树语义的 ←→ / Home / End 走 `treeKey`,
 * 不经这张表。
 */
const MOVE: Partial<Record<string, FocusDir>> = { 'move-up': 'up', 'move-down': 'down' }
const TREE: Partial<Record<string, TreeKeyIntent>> = {
  expand: 'expand',
  collapse: 'collapse',
  home: 'home',
  end: 'end',
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

/**
 * 「这一下键属于别人吗」—— 委托必须问的那一句(P1)。
 *
 * 树的结构键挂在**作用域根**上是事件委托(一个键一个产地),但这块面里还住着
 * 另外三种自己认结构键的控件:搜索框(文本编辑的基本盘)、侧栏那只
 * `role="option"` 列表(`ui/a11y/roving` 在容器上接方向键)、以及各种按钮
 * (Space / ↵ 是它们自己的激活键)。焦点落在它们身上时,这一下**不是树的**。
 *
 * 判据问的是**事件的 target**(键盘事件的 target 就是拿着焦点的那个元素),
 * 不是 `document.activeElement` —— 后者是响应链禁令的第三条。
 */
function ownsStructuralKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, button, [role="option"], [role="combobox"]'))
}

/**
 * 会话总览的内容面 —— 一块普通的 Dock 内容(id 'sessions'),所以它能上舞台 /
 * 变浮窗 / 钉到边,三种形态里长得一模一样(08-29 去接管化拍板:总览不再是盖满一屏的
 * 覆盖层)。它只负责**填满所属容器**,自己不画 scrim、不定位、不管进出场动画 ——
 * 那些是宿主那一层的事。
 *
 * 内部是**两层**视图 + 一台状态机:总览 / Quick Look ——「进某个组的列表」那一层
 * 09-04 随方向 A 退役(总览与组列表合并成同一张树,见
 * `docs/design/react-shell-sessions-list-2026-09.md` §1)。
 *
 * ── 谁来听键盘 ────────────────────────────────────────────────────────────
 * 只有**算数的那一份**听:摆出来了(placed)且宿主认它(interactive)。
 * 不算数的那一种实例照样渲染 —— 架子上被切到后台但仍挂着的 keep-alive 层 ——
 * 它只是不许占用 window 上的键盘。(09-02 之前还有一种:Dock 悬停预览泡。)
 *
 * ── Esc 的让位契约 ────────────────────────────────────────────────────────
 * 内层先消费:quicklook 上的 Esc 退一层并 preventDefault();
 * 已经在总览这一层时**不拦**,宿主(StageOverlay 只在 !defaultPrevented 时关面板)
 * 才轮得到。
 *
 * 「内层先」是**相位**保证的,不是注册序:这里听 `capture`,宿主听冒泡。
 * window 上的捕获监听器跑在传播的最前面,冒泡监听器跑在最后,中间隔着整条路径 ——
 * 谁先 addEventListener 都不影响。08-30 真机实录:靠注册序的旧写法在 React
 * StrictMode 双挂载下当场失效(ExposeView 的监听器被卸了再挂,排到了宿主后面),
 * 而「宿主用 queueMicrotask 推迟判定」这版修复同样失效 —— 微任务检查点在**每个
 * 监听器回调返回后**就跑,于是宿主的判定落在本监听器**之前**。详见 StageOverlay。
 */
export function ExposeView() {
  /**
   * view 要按**内容**比,不按引用比(useShallow):transitions 是纯函数,open()
   * 每次都造一个新的 `{ mode: 'overview' }` —— 切回这个 tab 时 live 升起必调 open(),
   * 引用比较会让这里每次都重渲染,连带把没 memo 的 Overview(439 张卡)整棵重造。
   * 内容没变就不重渲染,这一层不动,卡树自然一格不动(08-30 真机画像的第三记)。
   */
  /*
   * ── 键盘:从一条 window 捕获监听,变成这一格作用域的两句声明(09-03 R2)────
   * 方向键 / Space / ↵ 挂在作用域根上(行内结构键,不进任何表),Esc 走 `onEscape`。
   * 「谁来听」那个问题因此不再需要 `live` 那道自制的门:**在不在活动路径上**
   * 就是答案 —— 架子后台那一层被打了 `inert`,路径在那儿截断,它里面这一份
   * 连被问到的机会都没有(§4.7);而 `live` 那一格(placed × interactive)
   * 留着回答它原来的另一个问题:「这一份算不算数,要不要归位(open)」。
   */
  const view = useExposeStore(useShallow((st) => st.view))
  const rootRef = useRef<HTMLDivElement | null>(null)
  /**
   * 树容器那一格。**它是这块面真正的那个 Tab 位**(`role="tree" tabIndex=0`),
   * 活动行由 `aria-activedescendant` 指着 —— 所以「焦点交给列表」= 焦点落在它身上。
   */
  const treeRef = useRef<HTMLDivElement>(null)

  /**
   * 落点两档,判据是 `focusVisible`(键盘位显不显形):
   *  · 还没交接 → **搜索条**(「摆出来的那一刻键盘归这块面,焦点落进搜索条」);
   *  · 已经交给列表 → **树容器**。这一格不是可有可无的:交接之后焦点必须离开
   *    搜索条,否则 ↑↓/Space/↵ 会被「输入面里的无修饰单键」那条规则让给输入框,
   *    列表当场不动。从前那一手是 `blur()` —— 焦点掉到 body,而 R1 之后孤儿焦点
   *    会被收回落点,于是它会**弹回搜索条**。落点分两档才是这条手势在响应链上的
   *    正确写法。
   *
   * 搜索条按**取件口**取(`data-expose-search`,Toolbar 挂的),不为了一个落点
   * 去改库件 `ui/Input` 的 props 形状 —— 与 `viewer/JumpBar` 的
   * `restingTarget = () => root.querySelector('input')` 同一判例。
   */
  const restingTarget = useCallback(() => {
    if (useExposeStore.getState().focusVisible) return treeRef.current
    return rootRef.current?.querySelector<HTMLInputElement>('[data-expose-search]') ?? null
  }, [])

  /**
   * 面域局部键的**落点**(声明的正本是 `FOCUS_SCOPES.expose.keys`,今天一条:
   * ⌘⇧P = `pin.toggle`)。作用在**活动行**上 —— 与 `files` 那格 `⌘I` 同一手:
   * 不去读 `document.activeElement`,读这块面自己的选择状态(store 的 focusId)。
   * 没有活动行时这一下什么都不做(而不是让这一层去订阅 `focusId` ——
   * 订了它,每按一次方向键这整块面连同侧栏 / 工具栏都要跟着重渲一遍)。
   */
  const exposeKeys = useMemo(
    () => ({
      'pin.toggle': () => {
        const { focusId } = useExposeStore.getState()
        if (focusId) togglePinAndAnnounce(focusId)
      },
    }),
    [],
  )

  /**
   * Esc 的三档,次序与从前那条监听逐字相同:
   *  ① 总览这一层且搜索条有词 → **先清词**(Esc 的第 0 层);
   *  ② 总览这一层且没有词 → **不拦**,让宿主那一层去收这块面(退层链);
   *  ③ Quick Look → 退一层。
   */
  const onEscape = useCallback(() => {
    const st = useExposeStore.getState()
    if (st.view.mode === 'overview') {
      if (!st.query.trim()) return false
      st.setQuery('')
      return true
    }
    st.escape()
    return true
  }, [])

  /**
   * 方向键 / ←→ / Home / End / Space / ↵ —— 这块面的**行内结构键**(不进任何表),
   * 事件委托挂在作用域根上。三层让位,顺序就是判据:
   *  ① 别人已经接住了(`defaultPrevented`)—— 侧栏那只 roving 是唯一的常客,
   *    它在容器上消费方向键并 preventDefault;不让开的话侧栏里按一下 ↓
   *    会顺手把树的活动行也挪一格(一下键两处响);
   *  ② 输入框(搜索条)—— 方向键 / 空格属于文本编辑;
   *  ③ 其它自己认结构键的控件(侧栏项 / 选择器 / 按钮),见 `ownsStructuralKeys`。
   */
  const onGridKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const st = useExposeStore.getState()
    if (e.defaultPrevented) return
    // 输入框里方向键 / 空格属于输入框,不属于总览。
    if (isTypingTarget(e.target)) return

    const intent = exposeIntentOf(e.key)
    if (!intent) return

    if (st.view.mode === 'quicklook') {
      // Quick Look 里的 ←→ 是**换会话**(不是树的展开 / 收起):同一对键在两层
      // 各有各的语义,分岔判据就是这一句 `view.mode`,与迁到意图表之前逐字相同。
      if (intent === 'collapse') {
        e.preventDefault()
        st.quickLookPrev()
      } else if (intent === 'expand') {
        e.preventDefault()
        st.quickLookNext()
      } else if (intent === 'quicklook') {
        e.preventDefault()
        st.closeQuickLook()
      } else if (intent === 'enter') {
        e.preventDefault()
        st.enterSession(st.view.sessionId)
      }
      return
    }

    // 侧栏项 / 选择器 / 按钮各认各的结构键(Space 激活、roving 走位),这一下不是树的。
    if (ownsStructuralKeys(e.target)) return

    const dir = MOVE[intent]
    if (dir) {
      e.preventDefault()
      st.moveFocus(dir)
      return
    }
    /*
     * 树语义的 ←→ / Home / End(设计 §3.2):
     *  · → 房间未展开 → 展开;已展开 → 进第一个子行;非房间 → 无动作;
     *  · ← 子行 → 回父;展开的房间 → 收起;其余 → 无动作;
     *  · Home / End → 首行 / 末行。
     * 判定全在 `transitions.treeKey`(纯函数,有单测),这里只负责把意图递过去。
     */
    const tree = TREE[intent]
    if (tree) {
      e.preventDefault()
      st.treeKey(tree)
      return
    }
    if (intent === 'quicklook' && st.focusId) {
      e.preventDefault()
      st.openQuickLook(st.focusId)
      return
    }
    if (intent === 'enter' && st.focusId) {
      e.preventDefault()
      st.enterSession(st.focusId)
    }
  }, [])

  return (
    <FocusScope
      scope="expose"
      rootRef={rootRef}
      restingTarget={restingTarget}
      onEscape={onEscape}
      keyHandlers={exposeKeys}
    >
      {({ scopeProps }) => (
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
         * 方向键 / Space / ↵ 是**行内结构键**(不进任何表),它们是总览这套形态的
         * 语法本身;挂在作用域根上是事件委托,不是把一个 div 变成控件 ——
         * 焦点在里面那些真控件上(搜索条 / 树容器),与 `search/SearchPanel` 同判例。 */
        <div {...scopeProps} className={s.view} onKeyDown={onGridKey}>
          <ExposeBindings />
          <Overview treeRef={treeRef} />
          {view.mode === 'quicklook' && <QuickLook sessionId={view.sessionId} />}
        </div>
      )}
    </FocusScope>
  )
}

/**
 * 全局输入的占用,收在一个渲染 null 的叶子里 —— 这不是整理癖,是切 tab 的性能
 * 契约(08-30 真机画像):`live` 依赖宿主的可见性声明,切 tab 必翻它;谁在渲染
 * 输出里消费它,谁的子树就跟着翻转重渲。以前它长在 ExposeView 顶上,一次翻转
 * 就把 Overview 那 439 张卡整棵重造(dev ~300ms)。装进叶子后,翻转只重渲染
 * 这个 null 组件,卡树纹丝不动。
 *
 * `live` 的两半(placed × interactive)各是什么、为什么缺一不可,见 use-live.ts。
 * 归位(open)与键盘都只认这一个布尔量:live 升起那一刻归位 —— 而不是挂载那一刻
 * (出场动画会让内容在收回后多活一帧,那一帧里再开一次没有重新挂载;
 * 舞台 ⇄ 浮窗 ⇄ 架子搬家也不算重开,视图不会被搬没)。
 */
function ExposeBindings() {
  const open = useExposeStore((st) => st.open)
  const live = useExposeLive()

  useEffect(() => {
    if (live) open()
  }, [live, open])

  return null
}
