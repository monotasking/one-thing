import { useEffect, useState } from 'react'
import { useStageStore } from '../stage/store'
import { occludedByFull, useWorkbenchStore } from '../workbench/store'
import { stageIdOf } from '../stage/transitions'
import { findItem } from '../stage/items'
import { HostTitle, useHostTitleText } from './HostTitle'
import { renderContent } from '../content'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import { Menu, MenuItem, MenuSection } from '../ui/Menu'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
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
  /*
   * **被全屏盖住了吗**(W2)。舞台不是一个区域(它是形态机自己那格瞬态),所以
   * 这里问的是 `region: null` —— `occludedByFull` 那一句的读法是「全屏开着而这不是
   * 装着它的那个区域」,null 于是恒被盖住,而这正是对的:全屏 550 > overlay 500。
   */
  const occluded = useWorkbenchStore((st) => occludedByFull(st, null))
  const closeStage = useStageStore((st) => st.closeStage)
  const stageToEdge = useStageStore((st) => st.stageToEdge)
  const stageToFloat = useStageStore((st) => st.stageToFloat)

  const item = findItem(stageId)
  /*
   * 合檐后的内容由宿主檐说身份(同 FloatWindow)。取在早退之前 —— 它是 hook。
   * 退场那几帧走的是 `held`(此时 stageId 已经是 null),那时回落到静态名字:
   * 一块正在飞出去的面写着「查看器」而不是文件名,是可接受的,而且看不见。
   */
  const liveTitle = useHostTitleText(stageId, '')
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
   * ── Esc 不在这里了(08-31 搬走,09-02 R1 接进树)────────────────────────
   * 从前这一层自己挂一条 Esc 关舞台。搬走的理由是**它挡不住的那些形态**:
   * 这个组件只在有舞台时挂载,于是浮窗 / 盖按 Esc 全都掉进空里(用户 08-31
   * 报的「Esc 关不掉」正是这一条)。给浮窗也挂一条的话,「谁该先退」就会在
   * 三处各写一遍。
   *
   * 链仍然是 stage/transitions.escapeTargetOf 那个纯函数(盖 → 舞台 → 最上面
   * 那扇浮窗;架子是常驻家具,不在链里),它现在是**响应链根的 `onEscape`**
   * (AppShell 那一句),沿活动路径由深到浅问下来的最后一环。
   *
   * 这一层自己是响应链上的一格 `layer`(下面那个 `<FocusScope>`):它不认 Esc,
   * 只回答「焦点此刻在不在舞台里」—— 舞台里的浮层(菜单)因此在树上是它的孩子,
   * 一下 Esc 先关菜单、再轮到退层链收舞台。
   */

  const shown = item ?? held
  if (!shown) return null
  const leaving = !item
  const Icon = resolveIcon(shown.icon)
  const title = liveTitle || t(shown.titleKey)

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
      <FocusScope scope="stage-layer" owner={shown.id} inert={occluded}>
        {({ scopeProps }) => (
          <>
            <section
              {...scopeProps}
              inert={occluded || undefined}
              className={leaving ? `${s.panel} ${s.leaving}` : s.panel}
              role="dialog"
              aria-label={title}
            >
              <header className={s.header}>
                <Icon className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
                <HostTitle id={shown.id} fallback={t(shown.titleKey)} className={s.title} />
                {/* 「钉到边▸」是**带字的动作钮** → `ui/Button`(ghost 档);它透传
                  * ButtonHTMLAttributes,所以量矩形那一手(菜单贴它下缘开)一字未动。 */}
                <Button
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu({ x: r.left, y: r.bottom })
                  }}
                >
                  <Pin className={s.icon} strokeWidth={1.75} aria-hidden="true" />
                  {t('stage.pinToEdge')}
                </Button>
                {/* 另外两颗是纯图标钮 → `ui/IconButton` 的 md 档(28×28,与旧 .close 同尺寸)。 */}
                <IconButton
                  icon={PictureInPicture2}
                  size="md"
                  onClick={stageToFloat}
                  label={t('stage.toFloat')}
                />
                <IconButton icon={X} size="md" onClick={closeStage} label={t('common.close')} />
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
          </>
        )}
      </FocusScope>
    </div>
  )
}
