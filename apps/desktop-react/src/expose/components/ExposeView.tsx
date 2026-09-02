import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FocusScope } from '../../focus/FocusScope'
import { useExposeStore } from '../store'
import { useExposeLive } from './use-live'
import type { FocusDir } from '../types'
import { Overview } from './Overview'
import { ListView } from './ListView'
import { QuickLook } from './QuickLook'
import s from './ExposeView.module.css'

const ARROWS: Record<string, FocusDir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

/**
 * 会话总览的内容面 —— 一块普通的 Dock 内容(id 'sessions'),所以它能上舞台 /
 * 变浮窗 / 钉到边,三种形态里长得一模一样(08-29 去接管化拍板:总览不再是盖满一屏的
 * 覆盖层)。它只负责**填满所属容器**,自己不画 scrim、不定位、不管进出场动画 ——
 * 那些是宿主那一层的事。
 *
 * 内部仍是三层视图 + 一台状态机:总览 / 组列表 / Quick Look。
 *
 * ── 谁来听键盘 ────────────────────────────────────────────────────────────
 * 只有**算数的那一份**听:摆出来了(placed)且宿主认它(interactive)。
 * 不算数的那一种实例照样渲染 —— 架子上被切到后台但仍挂着的 keep-alive 层 ——
 * 它只是不许占用 window 上的键盘。(09-02 之前还有一种:Dock 悬停预览泡。)
 *
 * ── Esc 的让位契约 ────────────────────────────────────────────────────────
 * 内层先消费:quicklook / list 上的 Esc 退一层并 preventDefault();
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
   * 搜索条那一格。**落点**(`restingTarget`)在这一层持有,由 `Overview` 铺 ——
   * 「焦点进这块面时落在哪儿」是这一格作用域的声明,而搜索条只是它此刻的那个元素。
   */
  const searchRef = useRef<HTMLInputElement>(null)

  /**
   * 落点两档,判据是 `focusVisible`(键盘位显不显形):
   *  · 还没交接 → 搜索条(「摆出来的那一刻键盘归这块面,焦点落进搜索条」);
   *  · 已经交给网格 → **答不出**,于是落在这块面的根上(`restingElementOf` 的
   *    缺省档)。这一格不是可有可无的:交接之后焦点必须离开搜索条,否则
   *    ↑↓/Space/↵ 会被「输入面里的无修饰单键」那条规则让给输入框,网格当场不动。
   *    从前那一手是 `inputRef.current?.blur()` —— 焦点掉到 body,而 R1 之后
   *    孤儿焦点会被收回落点,于是它会**弹回搜索条**。落点分两档才是这条手势
   *    在响应链上的正确写法。
   */
  const restingTarget = useCallback(
    () => (useExposeStore.getState().focusVisible ? null : searchRef.current),
    [],
  )

  /**
   * Esc 的三档,次序与从前那条监听逐字相同:
   *  ① 总览这一层且搜索条有词 → **先清词**(Esc 的第 0 层);
   *  ② 总览这一层且没有词 → **不拦**,让宿主那一层去收这块面(退层链);
   *  ③ 组列表 / Quick Look → 退一层。
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
   * 方向键 / Space / ↵。判据一个字没改,只有「焦点在输入框里」那一条从
   * `e.target`(真机上它就是拿着焦点的那个元素)问,不再问一个全局。
   */
  const onGridKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const st = useExposeStore.getState()
    // 输入框里方向键 / 空格属于输入框,不属于总览。
    if (isTypingTarget(e.target)) return

    if (st.view.mode === 'quicklook') {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        st.quickLookPrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        st.quickLookNext()
      } else if (e.key === ' ') {
        e.preventDefault()
        st.closeQuickLook()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        st.enterSession(st.view.sessionId)
      }
      return
    }

    if (st.view.mode !== 'overview') return

    const dir = ARROWS[e.key]
    if (dir) {
      e.preventDefault()
      st.moveFocus(dir)
      return
    }
    if (e.key === ' ' && st.focusId) {
      e.preventDefault()
      st.openQuickLook(st.focusId)
      return
    }
    if (e.key === 'Enter' && st.focusId) {
      e.preventDefault()
      st.enterSession(st.focusId)
    }
  }, [])

  return (
    <FocusScope scope="expose" rootRef={rootRef} restingTarget={restingTarget} onEscape={onEscape}>
      {({ scopeProps }) => (
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
         * 方向键 / Space / ↵ 是**行内结构键**(不进任何表),它们是总览这套形态的
         * 语法本身;挂在作用域根上是事件委托,不是把一个 div 变成控件 ——
         * 焦点在里面那些真控件上(搜索条 / 卡),与 `search/SearchPanel` 同判例。 */
        <div {...scopeProps} className={s.view} onKeyDown={onGridKey}>
          <ExposeBindings />
          {view.mode === 'list' ? <ListView groupId={view.groupId} /> : <Overview searchRef={searchRef} />}
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
