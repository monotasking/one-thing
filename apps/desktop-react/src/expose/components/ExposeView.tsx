import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
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
  const view = useExposeStore(useShallow((st) => st.view))
  return (
    <div className={s.view}>
      <ExposeBindings />
      {view.mode === 'list' ? <ListView groupId={view.groupId} /> : <Overview />}
      {view.mode === 'quicklook' && <QuickLook sessionId={view.sessionId} />}
    </div>
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

  useEffect(() => {
    if (!live) return
    const onKey = (e: KeyboardEvent) => {
      const st = useExposeStore.getState()

      if (e.key === 'Escape') {
        // Esc 的第 0 层:搜索条有内容时先清词,再往上退。
        if (st.view.mode === 'overview') {
          if (!st.query.trim()) return
          e.preventDefault()
          st.setQuery('')
          return
        }
        e.preventDefault()
        st.escape()
        return
      }
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
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [live])

  return null
}
