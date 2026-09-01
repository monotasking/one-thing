import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Kbd } from '../ui/Kbd'
import { useT } from '../i18n'
import { useKeymapStore, currentKeymapPlatform } from '../keymap/store'
import {
  KEYMAP_COMMANDS,
  effectiveCombo,
  findCommand,
  formatCombo,
  hasOverride,
  recordKey,
} from '../keymap/transitions'
import type { CommandId } from '../keymap/types'
import s from './mocks.module.css'

/**
 * 设置页的「快捷键」区。一行 = 一条命令 + 它当下绑的键 + (改过才出现的)恢复默认。
 *
 * 三件事值得记一笔:
 * 1. 录制态的按键在 **window 的捕获阶段**被截住并 stopPropagation ——
 *    捕获在派发器(window 冒泡)之前跑,所以录 ⌘P 的时候检索面板不会真的弹出来。
 *    这不是「顺手加的保险」,是录制态成立的前提:不截住就没法录任何已绑的组合。
 * 2. 冲突**不静默覆盖**:撞了就留在录制态、行内说清撞的是谁,用户可以直接再按一个。
 * 3. 行不是一个 <button> —— 键位面与「恢复默认」是两颗兄弟按钮,不是嵌套的
 *    (嵌套 button 是铁律里的禁令,也确实点不动)。
 */
export function KeymapSettings() {
  const t = useT()
  const overrides = useKeymapStore((st) => st.overrides)
  const bind = useKeymapStore((st) => st.bind)
  const unbind = useKeymapStore((st) => st.unbind)
  const reset = useKeymapStore((st) => st.reset)

  /** 一次只有一行在录 —— 所以录制态住在这一层,而不是每行各存各的。 */
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [conflict, setConflict] = useState<CommandId | null>(null)

  const platform = currentKeymapPlatform()
  const state = { overrides }

  useEffect(() => {
    if (!recording) return

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      // 捕获阶段就掐断:这一下按键属于录制,不属于任何命令。
      e.stopPropagation()

      const outcome = recordKey(e)
      if (outcome.kind === 'ignore') return
      if (outcome.kind === 'cancel') {
        setRecording(null)
        setConflict(null)
        return
      }
      if (outcome.kind === 'unbind') {
        unbind(recording)
        setRecording(null)
        setConflict(null)
        return
      }
      const taken = bind(recording, outcome.combo)
      // 撞了就留在录制态,让用户直接再按一个 —— 退出去重来是白白多一步。
      if (taken) {
        setConflict(taken)
        return
      }
      setRecording(null)
      setConflict(null)
    }

    /*
     * ui-consume-allow: float-handwritten —— 这不是浮层散场,是**录制**。
     * 规则按「window 上的捕获相位 keydown」认人,而这条监听与 Esc 关一层毫无关系:
     * 它把录制态里的**每一下**按键都截住(preventDefault + stopPropagation),
     * 好让 ⌘P 这种已经绑出去的组合录得进来 —— 截不住就录不了任何已绑的键。
     * Esc 在这里也不是「关闭浮层」而是一条**录制结果**(`recordKey` 判 'cancel'),
     * 迁 useFloatDismiss 会把它变成一次散场:别的键当场全录不到。
     * 这一格没有浮层,连一块要散的面都没有。
     */
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, bind, unbind])

  return (
    <>
      <div className={s.sectionNote}>{t('keymap.hint')}</div>

      {KEYMAP_COMMANDS.map((command) => {
        const name = t(command.labelKey)
        const combo = effectiveCombo(state, command.id)
        const isRecording = recording === command.id
        const conflictWith = isRecording && conflict ? findCommand(conflict) : undefined

        return (
          <div className={s.field} key={command.id}>
            <div className={s.fieldLabel}>{name}</div>
            <div className={s.keyRight}>
              {conflictWith && (
                <span className={s.keyConflict}>
                  {t('keymap.conflict', { name: t(conflictWith.labelKey) })}
                </span>
              )}
              <button
                type="button"
                className={isRecording ? `${s.keySlot} ${s.keySlotOn}` : s.keySlot}
                aria-label={t('keymap.recordOf', { name })}
                onClick={() => {
                  setRecording(command.id)
                  setConflict(null)
                }}
              >
                {isRecording ? (
                  <span className={s.keyMuted}>{t('keymap.recording')}</span>
                ) : combo ? (
                  formatCombo(combo, platform).map((cap, i) => <Kbd key={i}>{cap}</Kbd>)
                ) : (
                  <span className={s.keyMuted}>{t('keymap.unbound')}</span>
                )}
              </button>
              {hasOverride(state, command.id) && (
                <Button
                  aria-label={t('keymap.resetOf', { name })}
                  onClick={() => {
                    reset(command.id)
                    if (isRecording) {
                      setRecording(null)
                      setConflict(null)
                    }
                  }}
                >
                  {t('keymap.reset')}
                </Button>
              )}
            </div>
          </div>
        )
      })}

      <div className={s.sectionNote}>{t('keymap.structuralNote')}</div>
    </>
  )
}
