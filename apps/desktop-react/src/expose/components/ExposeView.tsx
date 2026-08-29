import { useEffect } from 'react'
import { SESSIONS_ITEM_ID } from '../../stage/items'
import { useStageStore } from '../../stage/store'
import { formOf } from '../../stage/transitions'
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
 * ── Esc 的让位契约 ────────────────────────────────────────────────────────
 * 内层先消费:quicklook / list 上的 Esc 退一层并 preventDefault();
 * 已经在总览这一层时**不拦**,宿主(StageOverlay 只在 !defaultPrevented 时关面板)
 * 才轮得到。所以监听必须比宿主先挂上:这个 effect 的依赖是空的,
 * 状态一律现问 getState() —— 一旦依赖里塞进 view / query,导航一次监听就重挂一次,
 * 顺序会翻到宿主后面,契约当场失效。
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
   */
  const placed = useStageStore((st) => formOf(st, SESSIONS_ITEM_ID) !== 'dock')

  useEffect(() => {
    if (placed) open()
  }, [placed, open])

  useEffect(() => {
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

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={s.view}>
      {view.mode === 'list' ? <ListView groupId={view.groupId} /> : <Overview />}
      {view.mode === 'quicklook' && <QuickLook sessionId={view.sessionId} />}
    </div>
  )
}
