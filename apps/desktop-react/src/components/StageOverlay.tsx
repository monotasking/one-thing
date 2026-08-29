import { useEffect, useState } from 'react'
import { useStageStore } from '../stage/store'
import { stageIdOf } from '../stage/transitions'
import { findItem } from '../stage/items'
import { renderContent } from '../content'
import { useT } from '../i18n'
import { Menu, MenuItem, MenuSection } from '../ui/Menu'
import { resolveIcon, PictureInPicture2, Pin, X } from './icons'
import { EXIT_MS } from './motion'
import { SHELF_SIDE_CHOICES } from '../stage/types'
import type { StageItemSpec } from '../stage/types'
import s from './StageOverlay.module.css'

/**
 * 舞台永远挂载,只是可能什么都不渲染 —— 因为出场动画需要 item 在 state 清空后
 * 还多活一帧。这个「滞后」是本组件唯一的本地状态,形态机不该知道动画的存在。
 *
 * 头上是三个控件,恰好是舞台能去的三个地方:钉到边▸(四选一)、变浮窗、收回 Dock。
 */
export function StageOverlay() {
  const t = useT()
  const stageId = useStageStore(stageIdOf)
  const closeStage = useStageStore((st) => st.closeStage)
  const stageToEdge = useStageStore((st) => st.stageToEdge)
  const stageToFloat = useStageStore((st) => st.stageToFloat)

  const item = findItem(stageId)
  const [held, setHeld] = useState<StageItemSpec | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (item) {
      setHeld(item)
      return
    }
    if (!held) return
    const t = setTimeout(() => setHeld(null), EXIT_MS)
    return () => clearTimeout(t)
  }, [item, held])

  /**
   * Esc 关舞台 —— 但只在**内层没消费**这一下时。
   * 面里的内容可能自己有层次(会话总览的 quicklook / list),那几层先退;
   * 它们退不动了就不 preventDefault,这一下才轮到关面板。
   * 判据是 e.defaultPrevented 而不是「内容是谁」:舞台不认识住在里面的东西。
   */
  useEffect(() => {
    if (!stageId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      /*
       * 判定推迟到**整轮派发结束后**(微任务),不在自己这一格同步看
       * `defaultPrevented`:同目标同相位的监听器按注册序执行,而内容层的
       * 监听器可能注册在宿主之后 —— 真机抓到的现场是 React StrictMode 的
       * 开发期双挂载把 ExposeView 的监听器重排到了本组件后面,于是宿主先
       * 拿到 Esc、看见「还没人消费」就把面板关了,QuickLook 的那层让位被跳过。
       * `defaultPrevented` 在派发结束后是稳定的,微任务里读它,契约语义
       * 一字不变(「内层没消费这一下才轮到关面板」),对注册序彻底免疫。
       */
      queueMicrotask(() => {
        if (!e.defaultPrevented) closeStage()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stageId, closeStage])

  const shown = item ?? held
  if (!shown) return null
  const leaving = !item
  const Icon = resolveIcon(shown.icon)
  const title = t(shown.titleKey)

  return (
    <div
      className={leaving ? `${s.scrim} ${s.scrimLeaving}` : s.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeStage()
      }}
    >
      <section
        className={leaving ? `${s.panel} ${s.leaving}` : s.panel}
        role="dialog"
        aria-label={title}
      >
        <header className={s.header}>
          <Icon className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
          <span className={s.title}>{title}</span>
          <button
            type="button"
            className={s.action}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({ x: r.left, y: r.bottom })
            }}
          >
            <Pin className={s.icon} strokeWidth={1.75} aria-hidden="true" />
            {t('stage.pinToEdge')}
          </button>
          <button
            type="button"
            className={s.close}
            onClick={stageToFloat}
            aria-label={t('stage.toFloat')}
          >
            <PictureInPicture2 className={s.icon} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" className={s.close} onClick={closeStage} aria-label={t('common.close')}>
            <X className={s.icon} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className={s.body}>{renderContent(shown.id)}</div>
      </section>

      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={t('stage.pinToEdge')}>
          <MenuSection>{t('stage.pinToEdge')}</MenuSection>
          {SHELF_SIDE_CHOICES.map((c) => (
            <MenuItem
              key={c.value}
              onClick={() => {
                stageToEdge(c.value)
                setMenu(null)
              }}
            >
              {t(c.labelKey)}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  )
}
