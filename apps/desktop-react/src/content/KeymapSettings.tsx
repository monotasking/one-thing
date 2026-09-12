import { Fragment, useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { ButtonBase } from '../ui/ButtonBase'
import { Kbd } from '../ui/Kbd'
import { focusTree } from '../focus/registry'
import { useT } from '../i18n'
import { useKeymapStore, currentKeymapPlatform } from '../keymap/store'
import { answerersOf, claimantsOf, scopeLabelKeyOf } from '../keymap/scopes'
import {
  KEYMAP_COMMANDS,
  effectiveCombos,
  findCommand,
  formatCombo,
  hasOverride,
  recordKey,
  sharedChordOf,
} from '../keymap/transitions'
import type { KeymapCommand } from '../keymap/types'
import type { CommandId } from '../keymap/types'
import s from './mocks.module.css'

/**
 * 设置页的「快捷键」区。一行 = 一条命令 + 谁答得出它 + 它当下绑的键 +
 * (改过才出现的)恢复默认。
 *
 * ── 两节,分界是「有没有应用层兜底」(K0)────────────────────────────────
 * **全局**(`app: true`)= 焦点在哪儿都响,没人接住时由 `run-command.ts` 兜底。
 * **跟随焦点**(`app: false`)= 它需要一个由焦点决定的目标,所以没有兜底:
 * 活动路径上没人答就放行(页面 / PTY / 系统菜单接着走)。这不是排版,这就是
 * 三层立法那条判据本身 —— 从前跟随焦点那九条根本不在这块面上,用户既看不见
 * 「⌘F 是什么」,也改不了它。
 *
 * ── 「谁答」那一列 ──────────────────────────────────────────────────────
 * 读 `answerersOf`(正本 `focus/scopes.ts` 的 `answers`)。它回答的是那句从前
 * 只能从撞车里反推的话:「查找 ⌘F —— 浏览器(在这一页里查找)/ 终端(在这块
 * 屏幕里查找)/ 查看器(在这份文件里检索)」。**一条命令三个响应者**,三句话
 * 仍是三句,但它们挂在响应者上,不再各绑一次键。
 * 同一列还说得出第二件事:`claimantsOf` —— 这个键在哪块面里**归里面那台程序**
 * (Win / Linux 上终端认领的那五个 `Ctrl+字母`)。它不是命令、改不了、也不该被
 * 静默:用户有权在键位页上看见「⌘P 在终端里交给终端」。
 *
 * ── 两种撞车,两句不同的话(09-03 R3 立,K0 改口)─────────────────────────
 *  · **拒掉的**(`bindCombo` 回 `conflict`):按**冲突规则**判 —— 同一个键上
 *    `app: true` 的至多一条(`keymap.conflictApp`),其余每两条的作用域集合两两
 *    不交(`keymap.conflictOverlap`)。拒了就留在录制态、行内说清撞的是谁、
 *    按的是哪一条规则,让用户直接再按一个。
 *  · **放行的共键**(`sharedChordOf`):合法,而且往往正是**设计**(⌘L 上浏览器
 *    的地址栏与查看器的跳行)。所以它不拦写入,只在那一行旁边说一句
 *    「与「X」共用这个键(不同时在场)」—— 共键不是错误,但不许**静默**,那正是
 *    F1 那条留账要的东西。
 *
 * 三件事值得记一笔:
 * 1. 录制态向响应链**申请独占**(`focusTree.capture`,09-02 R1)。独占口是设计
 *    §5 里**唯一那条例外** —— 别的键都能写成一张表,而录制要吃的键集合不可枚举
 *    (它得能录下任何一个已经绑出去的组合)。截住这件事没变,只是改由那一个
 *    派发器代劳:它拿到独占口就一格作用域都不问,并在认领时 stopPropagation,
 *    所以录 ⌘P 的时候检索面板仍然不会真的弹出来。
 * 2. 冲突**不静默覆盖**:撞了就留在录制态、行内说清撞的是谁。
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
  /** 撞了的那一条:撞的是谁 + 按的是哪一条规则(`ComboConflict`)。 */
  const [conflict, setConflict] = useState<ReturnType<typeof bind>>(null)

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

  /** 撞车那一句:两条规则两句话,都带上撞的是谁。 */
  function conflictLine(): string | null {
    if (!conflict) return null
    const name = t(findCommand(conflict.with)?.labelKey ?? 'keymap.unbound')
    if (conflict.rule === 'app') return t('keymap.conflictApp', { name })
    return t('keymap.conflictOverlap', { name, scope: t(scopeLabelKeyOf(conflict.scope)) })
  }

  function row(command: KeymapCommand) {
    const name = t(command.labelKey)
    const combos = effectiveCombos(state, command.id)
    const isRecording = recording === command.id
    /*
     * 「谁答」= 声明这一头的响应者 + 认领这个键的那几块面。两者在这一列里同形
     * (面名 · 它管这件事叫什么),因为对用户来说它们回答的是同一个问题:
     * 「这个键按下去,在哪块面里会发生什么」。
     */
    const answerers = answerersOf(command.id).map((a) => ({
      key: `answer:${a.scope}`,
      text: t('keymap.answerer', { scope: t(scopeLabelKeyOf(a.scope)), action: t(a.labelKey) }),
    }))
    const claimants = claimantsOf(state, command.id).map((scope) => ({
      key: `claim:${scope}`,
      text: t('keymap.answerer', {
        scope: t(scopeLabelKeyOf(scope)),
        action: t('terminal.keyToPty'),
      }),
    }))
    const shared = sharedChordOf(state, command.id)

    return (
      <div className={s.settingRow} key={command.id}>
        <div className={s.settingRowLabel}>{name}</div>
        <div className={s.keyRight}>
          {[...answerers, ...claimants].map((line) => (
            <span className={s.keyConflict} key={line.key}>
              {line.text}
            </span>
          ))}
          {/* 合法的共键:不拦写入,只说清还有谁在这个键上(不同时在场)。 */}
          {shared.map((other) => (
            <span className={s.keyConflict} key={`shared:${other}`}>
              {t('keymap.sharedChord', { name: t(findCommand(other)?.labelKey ?? 'keymap.unbound') })}
            </span>
          ))}
          {isRecording && conflict && <span className={s.keyConflict}>{conflictLine()}</span>}
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
            ) : combos.length > 0 ? (
              /* 一条命令可以有好几个键面(⌘I 与 ⌘↵),中间用一枚哑分隔符隔开 ——
               * 那是**键盘上印的字**那一族,不是界面文案,所以不进字典。 */
              combos.map((combo, ci) => (
                <Fragment key={ci}>
                  {ci > 0 && <span className={s.keyMuted}>/</span>}
                  {formatCombo(combo, platform).map((cap, i) => (
                    <Kbd key={i}>{cap}</Kbd>
                  ))}
                </Fragment>
              ))
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
  }

  const appCommands = KEYMAP_COMMANDS.filter((c) => c.app)
  const scopedCommands = KEYMAP_COMMANDS.filter((c) => !c.app)

  return (
    <>
      <div className={s.sectionNote}>{t('keymap.hint')}</div>

      <h4 className={s.sectionTitle}>{t('keymap.sectionApp')}</h4>
      {appCommands.map(row)}

      <h4 className={s.sectionTitle}>{t('keymap.sectionScoped')}</h4>
      <div className={s.sectionNote}>{t('keymap.scopedNote2')}</div>
      {scopedCommands.map(row)}

      <div className={s.sectionNote}>{t('keymap.structuralNote')}</div>
    </>
  )
}
