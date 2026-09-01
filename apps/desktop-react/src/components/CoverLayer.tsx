import { useEffect, useState } from 'react'
import { useStageStore } from '../stage/store'
import { coverIdOf } from '../stage/transitions'
import { findItem } from '../stage/items'
import { HostTitle, useHostTitleText } from './HostTitle'
import { renderContent } from '../content'
import { useT } from '../i18n'
import { IconButton } from '../ui/IconButton'
import { resolveIcon, X } from './icons'
import { exitMs } from './motion'
import type { StageItemSpec } from '../stage/types'
import s from './CoverLayer.module.css'

/**
 * 第三种形态:**盖**(08-31 拍板)。
 *
 * ── 它与舞台差在哪 ───────────────────────────────────────────────────────
 * 两者**都**铺满整扇窗(09-01 用户推翻了 08-31 的「盖只接管中间那一栏」:
 * 「所有应用」的盖要盖满整个窗口,含侧边的架子)。差别因此收敛成两条一直就在的:
 *  · **形**:舞台是 scrim + 中间一块定尺画布;盖是一块吃满的面,只留一圈底。
 *  · **序**:盖压不过浮窗(--z-cover 100 < --z-float 200),也压不过 Dock(650)
 *    —— 盖开着时 Dock 照样唤得出、切得走。独占的是内容,不是整台机器。
 * 所以盖仍然适合「看一眼、点一下、就走」的整屏内容(所有应用是第一位用户)。
 *
 * 挂载点是这条语义的字面样子:它挂在**壳的根上**、position: fixed。
 * (08-31 那版挂在 .center 里 + absolute,那时「只接管一栏」就是这么写出来的。)
 *
 * 它不是新原语:落点、记忆、打开方式菜单、Esc 退层链,全部走既有那套
 * (Placement 多一个 kind 而已)。写在这里的只有「长什么样」。
 *
 * ── 「点击任意处关闭」读作「点在盖自己的底上」──────────────────────────
 * 拍板原话是「点击任意处/Esc 关闭」。字面上的「任意处」与这块面的第一位用户
 * 直接打架:所有应用面里每一行都有一枚开关,点开关的那一下要是也关掉盖,
 * 这块面就没法用。所以取的是与舞台 scrim 逐字相同的那条判据 ——
 * `e.target === e.currentTarget`,点在盖自己的底上才关,点在内容里不关;
 * Esc 与右上角那颗 ✕ 是另外两条出口。**这一条是我的读法,不是用户的原话**,
 * 已列进本批留账,用户可以推翻成「真·任意处」(那时所有应用得改成别的形态)。
 *
 * 挂载策略与 StageOverlay / FloatLayer 同一条判例:形态机不该知道动画的存在,
 * 所以「出场时多活一帧」是本组件自己的本地状态。
 */
export function CoverLayer() {
  const t = useT()
  const coverId = useStageStore(coverIdOf)
  const closeCover = useStageStore((st) => st.closeCover)

  const item = findItem(coverId)
  // 同 FloatWindow / StageOverlay:宿主檐替合檐后的内容说身份。取在早退之前(hook)。
  const liveTitle = useHostTitleText(coverId, '')
  const [held, setHeld] = useState<StageItemSpec | null>(null)

  useEffect(() => {
    if (item) {
      setHeld(item)
      return
    }
    if (!held) return
    // 每次都现问一次档(不缓存 —— 用户可能刚在设置面改过)。
    // 「无」档不排定时器,当场放掉:关掉就是没有,不是「关掉再过一拍」。
    const ms = exitMs()
    if (ms === 0) {
      setHeld(null)
      return
    }
    const timer = setTimeout(() => setHeld(null), ms)
    return () => clearTimeout(timer)
  }, [item, held])

  const shown = item ?? held
  if (!shown) return null
  const leaving = !item
  const Icon = resolveIcon(shown.icon)
  const title = liveTitle || t(shown.titleKey)

  return (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
     * 点底关闭是**鼠标的顺手路**,不是唯一出口:Esc 走退层链(useEscapeChain),
     * 右上角还有一颗真按钮。规则看不见那两条路径,所以它在这里是误报。
     * 刻意不给 role="button":盖的底不是按钮,报成按钮会让读屏软件念出一个
     * 不存在的控件(与 StageOverlay 的 scrim 同一条判例)。 */
    <div
      className={leaving ? `${s.cover} ${s.leaving}` : s.cover}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeCover()
      }}
    >
      <section className={s.panel} role="dialog" aria-label={title}>
        <header className={s.header}>
          <Icon className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
          <HostTitle id={shown.id} fallback={t(shown.titleKey)} className={s.title} />
          {/* 檐上那颗 ✕ 消费 `ui/IconButton`(md 档 = 28×28,与旧 `.close` 同尺寸);
            * 本地皮肤整份退役,hover / active / 焦点环从此随件走。 */}
          <IconButton icon={X} size="md" onClick={closeCover} label={t('cover.close')} />
        </header>
        <div className={s.body}>{renderContent(shown.id)}</div>
      </section>
    </div>
  )
}
