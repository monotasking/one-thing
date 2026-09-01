import { MenuItem, MenuSeparator } from '../../ui/Menu'
import { Kbd } from '../../ui/Kbd'
import { useT } from '../../i18n'
import { currentKeymapPlatform, useKeymapStore } from '../../keymap/store'
import { effectiveCombo, formatCombo, workspaceSlotCommandId } from '../../keymap/transitions'
import { useWorkspaceStore, useWorkspaceViews } from '../store'
import sw from '../swatch.module.css'
import s from './WorkspaceMenuRows.module.css'

/**
 * Dock 瓦右键菜单里那张**快切表** —— 08-31 追补裁定「切换器 = 一块普通 Dock 瓦,
 * 零新原语」的字面落地:它没有自己的浮层,就是塞进 Dock 既有 `<Menu>` 里的一串行。
 *
 * 一行 = 色点 + 名字 + ✓(当前)+ ⌘ 序号注记。这四件与命令面板的行、总览的卡
 * **同一份分子**(workspace/projection.ts 的 `WorkspaceView`),所以三处不会各说各话。
 *
 * 勾由 `MenuItem` 的 `checked` 画(它自己会把角色变成 menuitemradio 并占住勾位),
 * 所以这里既不自画对钩,也不做「选中就位移」那种会让菜单抖一下的事。
 *
 * 序号注记读的是**注册表当下的绑定**,不是一串写死的 ⌘1/2/3:用户在设置页把
 * ⌘2 改绑成别的,这里跟着变;解绑了就一个键帽都不画 —— 菜单不许说一句
 * 按下去没反应的话。
 */
interface Props {
  /** 「工作区总览…」那一行点下去做什么(打开这块瓦 —— 由 Dock 按它自己的打开方式开)。 */
  onOpenOverview: () => void
  /** 「＋ 新建工作区」那一行点下去做什么。 */
  onCreate: () => void
  /** 任何一行落定之后关掉菜单。 */
  onDone: () => void
}

export function WorkspaceMenuRows({ onOpenOverview, onCreate, onDone }: Props) {
  const t = useT()
  const views = useWorkspaceViews()
  const switchTo = useWorkspaceStore((st) => st.switchTo)
  const overrides = useKeymapStore((st) => st.overrides)
  const platform = currentKeymapPlatform()

  return (
    <>
      {views.map((view) => {
        const combo =
          view.slot === null ? null : effectiveCombo({ overrides }, workspaceSlotCommandId(view.slot))
        return (
          <MenuItem
            key={view.id}
            checked={view.isCurrent}
            onClick={() => {
              switchTo(view.id)
              onDone()
            }}
          >
            <span className={s.row}>
              <span className={`${s.swatch} ${sw[view.swatch]}`} aria-hidden="true" />
              <span className={s.name}>{view.name}</span>
              {combo && (
                <span className={s.keys}>
                  {formatCombo(combo, platform).map((cap) => (
                    <Kbd key={cap}>{cap}</Kbd>
                  ))}
                </span>
              )}
            </span>
          </MenuItem>
        )
      })}

      <MenuSeparator />

      <MenuItem
        onClick={() => {
          onOpenOverview()
          onDone()
        }}
      >
        {t('workspace.overviewEntry')}
      </MenuItem>
      <MenuItem
        onClick={() => {
          onCreate()
          onDone()
        }}
      >
        {t('workspace.create')}
      </MenuItem>
    </>
  )
}
