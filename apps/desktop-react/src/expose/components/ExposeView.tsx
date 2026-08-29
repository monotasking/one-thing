import { useEffect } from 'react'
import { SESSIONS_ITEM_ID } from '../../stage/items'
import { useStageStore } from '../../stage/store'
import { formOf } from '../../stage/transitions'
import { usePanelVisibility } from '../../content/visibility'
import { useExposeStore } from '../store'
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
 * 不算数的两种实例照样渲染 —— Dock 悬停预览泡、架子上被切到后台但仍挂着的
 * keep-alive 层 —— 它们只是不许占用 window 上的键盘。
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
  const view = useExposeStore((st) => st.view)
  const open = useExposeStore((st) => st.open)
  /**
   * 「这块面被摆出来了吗」—— 归位的时机就是这个布尔量翻成真的那一刻,
   * 而不是本组件挂载的那一刻:出场动画会让内容在收回之后再多活一帧(宿主的 held),
   * 那一帧里再开一次就没有重新挂载,挂载时机会漏掉这一次开场。
   * 只问真假不问落点,所以舞台 ⇄ 浮窗 ⇄ 架子之间搬家不算重开,视图不会被搬没。
   * 顺带:Dock 预览泡里的这一份 placed 恒为假 —— 悬停看一眼不该动状态机。
   *
   * 但 placed **一个人不够**:它是「这块内容摆出来了吗」这件全局事实,答不出
   * 「我这一份实例算不算数」。08-30 之前就漏在这里:预览泡那一份不 open(),
   * 却照样在 window 上挂了一份键盘监听。架子 keep-alive 之后后台那一份同理。
   * 所以下面还要问一次 usePanelVisibility()。
   */
  const placed = useStageStore((st) => formOf(st, SESSIONS_ITEM_ID) !== 'dock')
  /**
   * 「我这一份算不算数」—— 宿主说了算(见 content/visibility.ts)。
   * 两种不算数的实例:Dock 悬停预览泡里那一份,和架子上被切到后台、
   * 仍然挂着的那一份(keep-alive)。它们都渲染,但都不许占用全局键盘。
   */
  const { interactive } = usePanelVisibility()
  /** 摆出来了 **且** 这一份算数 —— 归位与键盘都只认这一个布尔量。 */
  const live = placed && interactive

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

  return (
    <div className={s.view}>
      {view.mode === 'list' ? <ListView groupId={view.groupId} /> : <Overview placed={live} />}
      {view.mode === 'quicklook' && <QuickLook sessionId={view.sessionId} />}
    </div>
  )
}
