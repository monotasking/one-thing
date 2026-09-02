import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { ButtonBase } from '../ui/ButtonBase'
import { Kbd } from '../ui/Kbd'
import { focusTree } from '../focus/registry'
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
 * 1. 录制态向响应链**申请独占**(`focusTree.capture`,09-02 R1;从前是这块面
 *    自己在 window 捕获阶段挂一条并 stopPropagation)。独占口是设计 §5 里
 *    **唯一那条例外** —— 别的键都能写成一张表,而录制要吃的键集合不可枚举
 *    (它得能录下任何一个已经绑出去的组合)。截住这件事没变,只是改由那一个
 *    派发器代劳:它拿到独占口就一格作用域都不问,并在认领时 stopPropagation,
 *    所以录 ⌘P 的时候检索面板仍然不会真的弹出来。这不是「顺手加的保险」,
 *    是录制态成立的前提。
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

    /*
     * 答 **true = 这一下我吃了**(派发器据此 preventDefault + stopPropagation)。
     * 录制态里**每一下**按键都归录制,连没认出来的(`ignore`,比如单按一个 ⌘)
     * 也一样 —— 那一下要是放出去,录 ⌘P 的中途检索面板就弹出来了。
     * Esc 在这里不是「关闭浮层」而是一条**录制结果**(`recordKey` 判 'cancel'),
     * 所以它也归这一口,不该落到响应链的退层链上。
     */
    return focusTree.capture((e) => {
      const outcome = recordKey(e)
      if (outcome.kind === 'ignore') return true
      if (outcome.kind === 'cancel') {
        setRecording(null)
        setConflict(null)
        return true
      }
      if (outcome.kind === 'unbind') {
        unbind(recording)
        setRecording(null)
        setConflict(null)
        return true
      }
      const taken = bind(recording, outcome.combo)
      // 撞了就留在录制态,让用户直接再按一个 —— 退出去重来是白白多一步。
      if (taken) {
        setConflict(taken)
        return true
      }
      setRecording(null)
      setConflict(null)
      return true
    })
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
          <div className={s.settingRow} key={command.id}>
            <div className={s.settingRowLabel}>{name}</div>
            <div className={s.keyRight}>
              {conflictWith && (
                <span className={s.keyConflict}>
                  {t('keymap.conflict', { name: t(conflictWith.labelKey) })}
                </span>
              )}
              {/* 键位面是一颗**结构件**(一格键位槽,视觉本该定制:录制态换底换边、
                * 里面装的是 Kbd 帽子)——三类判的第三类,清 UA 归 `ui/ButtonBase`。 */}
              <ButtonBase
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
              </ButtonBase>
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
