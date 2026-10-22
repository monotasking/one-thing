import { ButtonBase } from '../../ui/ButtonBase'
import { Tooltip } from '../../ui/Tooltip'
import { useT } from '../../i18n'
import { useWorkspaceStore, useWorkspaceViews } from '../store'
import sw from '../swatch.module.css'
import s from './WorkspaceDots.module.css'

/**
 * 左栏底那一排空间色点。切的是同一只 `switchTo`,所以和命令栏、Dock 菜单是同一份世界。
 * 色值不在这里:色标类把 `--ws-face` 指到 palette.css。
 */
export function WorkspaceDots() {
  const t = useT()
  const views = useWorkspaceViews()
  const switchTo = useWorkspaceStore((st) => st.switchTo)
  if (views.length === 0) return null

  return (
    <div className={s.bar} role="toolbar" aria-label={t('arc.spaces')}>
      {views.map((view) => (
        <Tooltip key={view.id} content={view.name}>
          <ButtonBase
            className={view.isCurrent ? `${s.space} ${s.spaceOn} ${sw[view.swatch]}` : `${s.space} ${sw[view.swatch]}`}
            aria-label={t('arc.spaceSwitch', { name: view.name })}
            aria-current={view.isCurrent ? 'true' : undefined}
            onClick={() => switchTo(view.id)}
          />
        </Tooltip>
      ))}
    </div>
  )
}
