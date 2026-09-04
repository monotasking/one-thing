import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { ButtonBase } from '../ui/ButtonBase'
import { Kbd } from '../ui/Kbd'
import { focusTree } from '../focus/registry'
import { FOCUS_SCOPES } from '../focus/scopes'
import { useT } from '../i18n'
import { useKeymapStore, currentKeymapPlatform } from '../keymap/store'
import { scopedCollisionsOf } from '../keymap/scopes'
import {
  KEYMAP_COMMANDS,
  commandVerbKeyOf,
  effectiveCombo,
  findCommand,
  formatCombo,
  hasOverride,
  recordKey,
} from '../keymap/transitions'
import type { CommandId } from '../keymap/types'
import type { MessageKey } from '../i18n'
import s from './mocks.module.css'

/**
 * 设置页的「快捷键」区。一行 = 一条命令 + 它当下绑的键 + (改过才出现的)恢复默认。
 *
 * ── 两种撞车,两句不同的话(09-03 R3)────────────────────────────────────
 * 这块面要说得出**两种**撞车,它们的严重程度根本不同:
 *  · **全局 ↔ 全局**(`bind` 回一个被占的 command id):真的有一个按不响 ——
 *    所以它拦住写入,留在录制态、行内说清撞的是谁,让用户直接再按一个。
 *  · **全局 ↔ 面域局部键**(`scopedCollisionsOf`,读的是正本
 *    `focus/scopes.ts` 的 `FOCUS_SCOPES[id].keys`):**不是错误**,两者共存 ——
 *    局部先接、没接住放行全局(⌘I 在文件树里开详情,在别处仍是那条全局命令)。
 *    所以它不拦写入,只在那一行旁边**说出所属的那块面**(用作用域自己的
 *    `labelKey`,「文件」「查看器」……),这正是 F1 那条留账要的东西:从前
 *    「用户把某条命令改绑到 ⌘I」是**静默**盖住行内键的。
 *    出厂表下零撞车,所以这句话默认一个字都不出现。
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

  /**
   * 一条命令在这块面上的名字。带动词壳的那一族(今天只有召唤)套一层,别的原样。
   * 抽成一句是因为它有**两个**读者:行标签,与撞车提示里那个「与『X』冲突」——
   * 两处各拼一遍迟早分叉(一处说「召唤『文件』」另一处说「文件」)。
   */
  const commandNameOf = (command: { id: CommandId; labelKey: MessageKey }): string => {
    const bare = t(command.labelKey)
    const verb = commandVerbKeyOf(command.id)
    return verb ? t(verb, { name: bare }) : bare
  }

  const platform = currentKeymapPlatform()
  const state = { overrides }
  /** 全局命令与面域局部键撞在同一个组合上的那些。出厂表下是空的。 */
  const scopedCollisions = scopedCollisionsOf(state)

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
        const name = commandNameOf(command)
        const combo = effectiveCombo(state, command.id)
        const isRecording = recording === command.id
        const conflictWith = isRecording && conflict ? findCommand(conflict) : undefined
        const scoped = scopedCollisions.filter((c) => c.command === command.id)

        return (
          <div className={s.settingRow} key={command.id}>
            <div className={s.settingRowLabel}>{name}</div>
            <div className={s.keyRight}>
              {conflictWith && (
                <span className={s.keyConflict}>
                  {t('keymap.conflict', { name: commandNameOf(conflictWith) })}
                </span>
              )}
              {/* 面域局部键那种撞车:不拦写入,只说清是**哪一块面**里的**哪个动作**
                * 占着这个组合(局部先接、没接住放行全局)。同一句话与全局撞车共用
                * 一件皮肤(fs-micro + text-3):两者都是行内的一句提示,不是错误态。 */}
              {scoped.map((c) => (
                <span className={s.keyConflict} key={`${c.scoped.scope}:${c.scoped.action}`}>
                  {t('keymap.scopedConflict', {
                    scope: t(FOCUS_SCOPES[c.scoped.scope].labelKey),
                    action: t(c.scoped.labelKey),
                  })}
                </span>
              ))}
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
