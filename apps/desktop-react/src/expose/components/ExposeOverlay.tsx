import { useEffect, useState } from 'react'
import { EXIT_MS } from '../../components/motion'
import { useT } from '../../i18n'
import { useExposeStore } from '../store'
import type { ExposeView, FocusDir } from '../types'
import { Overview } from './Overview'
import { ListView } from './ListView'
import { QuickLook } from './QuickLook'
import s from './ExposeOverlay.module.css'

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
 * 总览层永远挂载,只是可能什么都不渲染 —— 和 StageOverlay 同一个判例:
 * 出场动画需要视图在 view 变回 closed 之后还多活一帧,这个「滞后」是
 * 本组件唯一的本地状态,状态机不该知道动画的存在。
 */
export function ExposeOverlay() {
  const t = useT()
  const view = useExposeStore((st) => st.view)
  const focusId = useExposeStore((st) => st.focusId)
  const query = useExposeStore((st) => st.query)
  const toggle = useExposeStore((st) => st.toggle)
  const escape = useExposeStore((st) => st.escape)
  const setQuery = useExposeStore((st) => st.setQuery)
  const moveFocus = useExposeStore((st) => st.moveFocus)
  const openQuickLook = useExposeStore((st) => st.openQuickLook)
  const closeQuickLook = useExposeStore((st) => st.closeQuickLook)
  const quickLookPrev = useExposeStore((st) => st.quickLookPrev)
  const quickLookNext = useExposeStore((st) => st.quickLookNext)
  const enterSession = useExposeStore((st) => st.enterSession)

  const [held, setHeld] = useState<ExposeView | null>(null)

  useEffect(() => {
    if (view.mode !== 'closed') {
      setHeld(view)
      return
    }
    if (!held) return
    const t = setTimeout(() => setHeld(null), EXIT_MS)
    return () => clearTimeout(t)
  }, [view, held])

  // ⌘P 是唯一的常驻监听:它得能在总览关着的时候把总览叫起来。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'p') return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  // 其余按键只在总览开着时接管;关着时这个 effect 直接返回 = 零监听,不碰 composer。
  useEffect(() => {
    if (view.mode === 'closed') return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // Esc 的第 0 层:搜索条有内容时先清词,再往上退。
        if (view.mode === 'overview' && query.trim()) setQuery('')
        else escape()
        return
      }
      // 输入框里方向键 / 空格属于输入框,不属于总览。
      if (isTypingTarget(e.target)) return

      if (view.mode === 'quicklook') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          quickLookPrev()
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          quickLookNext()
        } else if (e.key === ' ') {
          e.preventDefault()
          closeQuickLook()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          enterSession(view.sessionId)
        }
        return
      }

      if (view.mode !== 'overview') return

      const dir = ARROWS[e.key]
      if (dir) {
        e.preventDefault()
        moveFocus(dir)
        return
      }
      if (e.key === ' ' && focusId) {
        e.preventDefault()
        openQuickLook(focusId)
        return
      }
      if (e.key === 'Enter' && focusId) {
        e.preventDefault()
        enterSession(focusId)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    view,
    focusId,
    query,
    escape,
    setQuery,
    moveFocus,
    openQuickLook,
    closeQuickLook,
    quickLookPrev,
    quickLookNext,
    enterSession,
  ])

  const shown = view.mode !== 'closed' ? view : held
  if (!shown) return null
  const leaving = view.mode === 'closed'

  return (
    <div
      className={leaving ? `${s.layer} ${s.leaving}` : s.layer}
      role="dialog"
      aria-label={t('expose.title')}
      aria-modal="true"
    >
      {shown.mode === 'list' ? <ListView groupId={shown.groupId} /> : <Overview />}
      {shown.mode === 'quicklook' && <QuickLook sessionId={shown.sessionId} />}
    </div>
  )
}
