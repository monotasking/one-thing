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

  /**
   * Esc 关舞台 —— 但只在**内层没消费**这一下时。
   * 面里的内容可能自己有层次(会话总览的 quicklook / list),那几层先退;
   * 它们退不动了就不 preventDefault,这一下才轮到关面板。
   * 判据是 e.defaultPrevented 而不是「内容是谁」:舞台不认识住在里面的东西。
   *
   * 「谁先」不靠注册序,靠**传播相位**:宿主听冒泡(这里,默认相位),内容层听捕获
   * (ExposeView)。window 上的捕获监听器永远跑在同一个 window 上的冒泡监听器之前,
   * 与两者谁先注册无关 —— 于是同步读 defaultPrevented 就是稳的。
   *
   * 曾经的两版错法,都留在这儿当判例:
   *  ① 同相位 + 同步读:注册序说了算,而 React StrictMode 的开发期双挂载会把
   *     ExposeView 的监听器卸了再挂,最终排到本组件之后 —— QuickLook 开着按 Esc
   *     整块面板被关。
   *  ② 同相位 + queueMicrotask 推迟判定:以为微任务落在「整轮派发结束后」。不是。
   *     微任务检查点在**每个监听器回调返回后**就跑(真事件由原生派发,回调之间
   *     JS 栈是空的),所以它落在下一个监听器**之前** —— 08-30 真机实录:宿主的
   *     微任务先跑并 closeStage(),ExposeView 才拿到这一下。
   *     jsdom 里测不出来:fireEvent 是从 JS 里派发的,整轮派发都在一层 JS 栈上,
   *     微任务只好等到最后 —— 于是那版修复的单测是绿的,真机是红的。
   */
  useEffect(() => {
    if (!stageId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      closeStage()
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
