import { useEffect, useState } from 'react'
import { useStageStore } from '../stage/store'
import { findItem } from '../stage/items'
import { renderContent } from '../content'
import { useT } from '../i18n'
import { resolveIcon, Pin, X } from './icons'
import { EXIT_MS } from './motion'
import type { StageItemSpec } from '../stage/types'
import s from './StageOverlay.module.css'

/**
 * 舞台永远挂载,只是可能什么都不渲染 —— 因为出场动画需要 item 在 state 清空后
 * 还多活一帧。这个「滞后」是本组件唯一的本地状态,形态机不该知道动画的存在。
 */
export function StageOverlay() {
  const t = useT()
  const stageId = useStageStore((st) => st.stageId)
  const closeStage = useStageStore((st) => st.closeStage)
  const pinStage = useStageStore((st) => st.pinStage)

  const item = findItem(stageId)
  const [held, setHeld] = useState<StageItemSpec | null>(null)

  useEffect(() => {
    if (item) {
      setHeld(item)
      return
    }
    if (!held) return
    const t = setTimeout(() => setHeld(null), EXIT_MS)
    return () => clearTimeout(t)
  }, [item, held])

  // Esc 关。舞台一次只有一个,所以「仅最上层」是结构保证:没有第二个监听者。
  useEffect(() => {
    if (!stageId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeStage()
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
          <button type="button" className={s.action} onClick={pinStage}>
            <Pin className={s.icon} strokeWidth={1.75} aria-hidden="true" />
            {t('stage.pinToRight')}
          </button>
          <button type="button" className={s.close} onClick={closeStage} aria-label={t('common.close')}>
            <X className={s.icon} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className={s.body}>{renderContent(shown.id)}</div>
      </section>
    </div>
  )
}
