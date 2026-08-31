import { useEffect, useState } from 'react'
import { useStageStore } from '../stage/store'
import { stageIdOf } from '../stage/transitions'
import { findItem } from '../stage/items'
import { renderContent } from '../content'
import { useT } from '../i18n'
import { Menu, MenuItem, MenuSection } from '../ui/Menu'
import { resolveIcon, PictureInPicture2, Pin, X } from './icons'
import { exitMs } from './motion'
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
    // 每次都现问一次档(不缓存 —— 用户可能刚在设置面改过)。
    const ms = exitMs()
    // 「无」档:**不排定时器**,当场放掉。挂一个 0ms 的定时器也能到,但那要多等
    // 一个宏任务 —— 用户选「无」要的是「关掉就是没有」,不是「关掉再过一拍」。
    if (ms === 0) {
      setHeld(null)
      return
    }
    const t = setTimeout(() => setHeld(null), ms)
    return () => clearTimeout(t)
  }, [item, held])

  /*
   * ── Esc 不在这里了(08-31 搬走)──────────────────────────────────────
   * 从前这一层自己挂一条 Esc 关舞台。搬走的理由是**它挡不住的那些形态**:
   * 这个组件只在有舞台时挂载,于是浮窗 / 盖按 Esc 全都掉进空里(用户 08-31
   * 报的「Esc 关不掉」正是这一条,真机复现:浮窗按 Esc,placements 一个字节
   * 不变)。给浮窗也挂一条的话,「谁该先退」就会在三处各写一遍。
   *
   * 现在链是 stage/transitions.escapeTargetOf 那个纯函数(盖 → 舞台 → 最上面
   * 那扇浮窗;架子是常驻家具,不在链里),宿主只剩一条 window 监听:
   * components/useEscapeChain。那里也保管着这一段的全部判例 ——
   * 「内层先退」靠的是**传播相位**(内容听捕获、宿主听冒泡)而不是注册序,
   * 以及两版错法(同相位+同步读会被 StrictMode 双挂载翻盘;queueMicrotask
   * 推迟判定会落在下一个监听器**之前**)的病历。
   */

  const shown = item ?? held
  if (!shown) return null
  const leaving = !item
  const Icon = resolveIcon(shown.icon)
  const title = t(shown.titleKey)

  return (
/* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
     * 遮罩点击关闭是**鼠标的顺手路**,不是唯一出口:Esc 已经能关(键盘监听见本文件 /
     * ExposeView 的 escape 分支),关闭按钮也在。规则看不见那条键盘路径,所以它在这里
     * 是误报。刻意不给它 role="button":遮罩不是按钮,报成按钮会让读屏软件念出一个
     * 不存在的控件。 */
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
