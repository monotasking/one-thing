import { useEffect, useRef, useState } from 'react'
import { Plus, X } from '../components/icons'
import { Button } from '../ui/Button'
import { ButtonBase } from '../ui/ButtonBase'
import { IconButton } from '../ui/IconButton'
import { Kbd } from '../ui/Kbd'
import { Select } from '../ui/Select'
import { focusTree } from '../focus/registry'
import { useT } from '../i18n'
import { useKeymapStore, useKeymapState, currentKeymapPlatform } from '../keymap/store'
import { answerersOf, claimantsOf, scopeLabelKeyOf } from '../keymap/scopes'
import { importVscodeKeybindings } from '../keymap/import-vscode'
import { parseProfileJson, profileFromState, serializeProfile } from '../keymap/profile-io'
import { downloadJsonFile, keymapProfileFileName } from '../keymap/profile-file'
import {
  KEYMAP_COMMANDS,
  activeProfile,
  effectiveCombos,
  findCommand,
  formatCombo,
  hasOverride,
  isProfileBound,
  listProfiles,
  recordKey,
  sharedChordOf,
} from '../keymap/transitions'
import type { Combo, KeymapCommand } from '../keymap/types'
import type { CommandId } from '../keymap/types'
import s from './mocks.module.css'

/**
 * 设置页的「快捷键」区。顶上一格**键位组**,下面一行 = 一条命令 + 谁答得出它 +
 * 它当下绑的那几个键 +(改过才出现的)恢复默认。
 *
 * ── 三层,自上而下(K5)─────────────────────────────────────────────────
 *   用户逐格覆盖  ▷  当前键位组  ▷  出厂表
 * 顶上那格选择器换的是**中间那层**,逐格改绑落在**最上面那层** —— 所以换组
 * 不丢手(判词整段在 `keymap/profiles.ts` 上)。一行的键位若来自当前组而不是
 * 出厂表,那一行自己会说一句「来自「VS Code」组」:用户按下去发现键变了,
 * 得能就地看见是谁改的。
 *
 * ── 一个键位槽里可以有好几枚键(K5;K0 留的那笔账)──────────────────────
 * 从前录一次 = 整条换成那一个键,于是 `files.detail` 的第二个出厂键 ⌘↵ 一旦被
 * 覆盖就再也回不来 —— 「一条命令可以有好几个键面」这件事用户看得见却做不出来。
 * 现在槽里画**全部**键面,每枚尾巴上一颗 ×(删这一枚),槽尾一颗 ＋(**追加**
 * 一枚)。× 与 ＋ 是**兄弟**不是嵌套 —— 嵌套 `<button>` 是禁令,也确实点不动
 * (同 `ui/FilterChip` 那颗 × 的判词)。
 *
 * ── 两节,分界是「有没有应用层兜底」(K0)────────────────────────────────
 * **全局**(`app: true`)= 焦点在哪儿都响,没人接住时由 `run-command.ts` 兜底。
 * **跟随焦点**(`app: false`)= 它需要一个由焦点决定的目标,所以没有兜底:
 * 活动路径上没人答就放行(页面 / PTY / 系统菜单接着走)。这不是排版,这就是
 * 三层立法那条判据本身。
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
 *    「与「X」共用这个键(不同时在场)」—— 共键不是错误,但不许**静默**。
 *    切到 VS Code 组之后 ⌥⌘→ 与右架子的共键也由这一句说出来。
 *
 * 三件事值得记一笔:
 * 1. 录制态向响应链**申请独占**(`focusTree.capture`,09-02 R1)。独占口是设计
 *    §5 里**唯一那条例外** —— 别的键都能写成一张表,而录制要吃的键集合不可枚举
 *    (它得能录下任何一个已经绑出去的组合)。截住这件事没变,只是改由那一个
 *    派发器代劳:它拿到独占口就一格作用域都不问,并在认领时 stopPropagation,
 *    所以录 ⌘⇧F 的时候检索面板仍然不会真的弹出来。
 * 2. 冲突**不静默覆盖**:撞了就留在录制态、行内说清撞的是谁。
 * 3. 录制态里那颗 ＋ **不卸载**(只换槽里画什么):卸载它等于把焦点丢给 `<body>`,
 *    那是响应链不变量 I1 明令禁止的一件事。
 */

/** 导入报告:一次导入 / 导出之后那块面要说的话。`kind` 决定说哪几句。 */
type ImportSummary =
  | { kind: 'imported'; name: string; accepted: number; unknown: string[]; bad: string[]; when: string[] }
  | { kind: 'exported'; name: string }
  | { kind: 'failed'; reason: 'read' | 'json' | 'shape' | 'export' }

export function KeymapSettings() {
  const t = useT()
  const keymap = useKeymapState()
  const bind = useKeymapStore((st) => st.bind)
  const removeCombo = useKeymapStore((st) => st.removeCombo)
  const unbind = useKeymapStore((st) => st.unbind)
  const reset = useKeymapStore((st) => st.reset)
  const setProfile = useKeymapStore((st) => st.setProfile)
  const addUserProfile = useKeymapStore((st) => st.addUserProfile)

  /** 一次只有一行在录 —— 所以录制态住在这一层,而不是每行各存各的。 */
  const [recording, setRecording] = useState<CommandId | null>(null)
  /** 撞了的那一条:撞的是谁 + 按的是哪一条规则(`ComboConflict`)。 */
  const [conflict, setConflict] = useState<ReturnType<typeof bind>>(null)
  /** 上一次导入 / 导出说了什么。null = 这一趟还没做过这件事。 */
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const platform = currentKeymapPlatform()
  const profile = activeProfile(keymap)

  useEffect(() => {
    if (!recording) return

    /*
     * 答 **true = 这一下我吃了**(派发器据此 preventDefault + stopPropagation)。
     * 录制态里**每一下**按键都归录制,连没认出来的(`ignore`,比如单按一个 ⌘)
     * 也一样 —— 那一下要是放出去,录 ⌘⇧F 的中途检索面板就弹出来了。
     * Esc 在这里不是「关闭浮层」而是一条**录制结果**(`recordKey` 判 'cancel'),
     * 所以它也归这一口,不该落到响应链的退层链上。
     *
     * `platform` 是必填的(K5):没有它就认不出「另一枚」那一枚修饰键 ——
     * mac 上录 ⌃Tab 会存成 ⌘Tab(K2 留的那笔账)。
     */
    return focusTree.capture((e) => {
      const outcome = recordKey(e, platform)
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
  }, [recording, bind, unbind, platform])

  /** 撞车那一句:两条规则两句话,都带上撞的是谁。 */
  function conflictLine(): string | null {
    if (!conflict) return null
    const name = t(findCommand(conflict.with)?.labelKey ?? 'keymap.unbound')
    if (conflict.rule === 'app') return t('keymap.conflictApp', { name })
    return t('keymap.conflictOverlap', { name, scope: t(scopeLabelKeyOf(conflict.scope)) })
  }

  /**
   * 读进来的这份文件是**谁的**,由它的形状说了算:VS Code 的
   * `keybindings.json` 顶层永远是一个**数组**,这台壳自己的键位组永远是一个
   * **对象**。所以不问扩展名、不问文件名 —— 那两样都是用户随手起的。
   */
  async function onFile(file: File): Promise<void> {
    /*
     * 读盘这一下会失败(文件被移走 / 权限没了),而它失败的方式与「读不懂」
     * 不是同一件事 —— 混成一句话会让用户去改一份其实没问题的文件。
     */
    let text: string
    try {
      text = await file.text()
    } catch {
      setSummary({ kind: 'failed', reason: 'read' })
      return
    }
    const fallback = file.name.replace(/\.json$/i, '') || t('keymap.myProfile')
    const looksVscode = text.trimStart().startsWith('[')
    const report = looksVscode
      ? importVscodeKeybindings(text, platform, fallback)
      : parseProfileJson(text, platform, fallback)
    if (!report.profile) {
      setSummary({ kind: 'failed', reason: report.error ?? 'shape' })
      return
    }
    addUserProfile(report.profile)
    setSummary({
      kind: 'imported',
      name: report.profile.name,
      accepted: report.accepted,
      unknown: report.unknownCommands,
      bad:
        'badChords' in report
          ? report.badChords.map((r) => `${r.chord} (${r.command})`)
          : report.badKeys.map((r) => `${r.key} (${r.command})`),
      when: 'ignoredWhen' in report ? report.ignoredWhen.map((r) => `${r.command} — ${r.when}`) : [],
    })
  }

  function onExport(): void {
    /*
     * 导出的是**当下这张有效表**(三层落完),名字取当前组的名字;出厂组没有
     * 「用户的名字」可用,所以那一档叫「我的键位」——导出的是他此刻的手,不是
     * 出厂表本身。
     */
    const name = profile && !profile.builtin ? profile.name : t('keymap.myProfile')
    const made = profileFromState(keymap, name)
    const ok = downloadJsonFile(keymapProfileFileName(name), serializeProfile(made, platform))
    setSummary(ok ? { kind: 'exported', name } : { kind: 'failed', reason: 'export' })
  }

  function summaryLines(): string[] {
    if (!summary) return []
    if (summary.kind === 'exported') return [t('keymap.exportDone', { name: summary.name })]
    if (summary.kind === 'failed') {
      if (summary.reason === 'read') return [t('keymap.importFailRead')]
      if (summary.reason === 'json') return [t('keymap.importFailJson')]
      if (summary.reason === 'export') return [t('keymap.exportFail')]
      return [t('keymap.importFailShape')]
    }
    const lines = [t('keymap.importDone', { name: summary.name, count: String(summary.accepted) })]
    /* 读不懂的逐条列出来 —— 静默吞掉一行是这类功能最典型的病。 */
    if (summary.unknown.length > 0)
      lines.push(t('keymap.importUnknown', { list: summary.unknown.join('、') }))
    if (summary.bad.length > 0) lines.push(t('keymap.importBadChord', { list: summary.bad.join('、') }))
    if (summary.when.length > 0) lines.push(t('keymap.importWhen', { list: summary.when.join('、') }))
    return lines
  }

  function keyFace(command: KeymapCommand, name: string, combo: Combo, index: number) {
    const caps = formatCombo(combo, platform)
    return (
      <span className={s.keyFace} key={index}>
        {caps.map((cap, i) => (
          <Kbd key={i}>{cap}</Kbd>
        ))}
        <IconButton
          icon={X}
          size="xs"
          tip={false}
          label={t('keymap.removeKey', { name, combo: caps.join(' ') })}
          onClick={() => removeCombo(command.id, combo)}
        />
      </span>
    )
  }

  function row(command: KeymapCommand) {
    const name = t(command.labelKey)
    const combos = effectiveCombos(keymap, command.id)
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
    const claimants = claimantsOf(keymap, command.id).map((scope) => ({
      key: `claim:${scope}`,
      text: t('keymap.answerer', {
        scope: t(scopeLabelKeyOf(scope)),
        action: t('terminal.keyToPty'),
      }),
    }))
    const shared = sharedChordOf(keymap, command.id)
    /* 这一行的键来自当前组而不是出厂表时说一句出处(被用户覆盖了就不是组说了算)。 */
    const fromProfile =
      !hasOverride(keymap, command.id) && isProfileBound(profile, command.id) && profile !== undefined

    return (
      <div className={s.settingRow} key={command.id}>
        <div className={s.settingRowLabel}>{name}</div>
        <div className={s.keyRight}>
          {[...answerers, ...claimants].map((line) => (
            <span className={s.keyConflict} key={line.key}>
              {line.text}
            </span>
          ))}
          {fromProfile && (
            <span className={s.keyConflict}>
              {t('keymap.fromProfile', { name: profileName(profile?.id ?? '', profile?.name ?? '') })}
            </span>
          )}
          {/* 合法的共键:不拦写入,只说清还有谁在这个键上(不同时在场)。 */}
          {shared.map((other) => (
            <span className={s.keyConflict} key={`shared:${other}`}>
              {t('keymap.sharedChord', { name: t(findCommand(other)?.labelKey ?? 'keymap.unbound') })}
            </span>
          ))}
          {isRecording && conflict && <span className={s.keyConflict}>{conflictLine()}</span>}
          {/*
            * 键位槽是一格**容器**(不是一颗钮):里面装着这一条当下的全部键面,
            * 每枚一颗 ×;槽尾那颗 ＋ 才是录制的入口。这一格的视觉本该定制
            * (录制态换底换边),所以 ＋ 走 `ui/ButtonBase`(三类判的第三类)。
            */}
          <div
            className={isRecording ? `${s.keySlot} ${s.keySlotOn}` : s.keySlot}
            /* DOM 契约:这一格是**容器**不是钮,所以它没有可访问名 —— 门与用例
             * 要量「这一条此刻画着哪几枚键」只能认这一格。 */
            data-key-slot={command.id}
          >
            {isRecording ? (
              <span className={s.keyMuted}>{t('keymap.recording')}</span>
            ) : combos.length > 0 ? (
              combos.map((combo, ci) => keyFace(command, name, combo, ci))
            ) : (
              <span className={s.keyMuted}>{t('keymap.unbound')}</span>
            )}
            <ButtonBase
              className={s.keyAdd}
              aria-label={t('keymap.recordOf', { name })}
              onClick={() => {
                setRecording(command.id)
                setConflict(null)
              }}
            >
              <Plus size={12} />
            </ButtonBase>
          </div>
          {hasOverride(keymap, command.id) && (
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

  /** 内置的出厂组那一格名字走字典(它是界面文案);别的组名是专名 / 用户写的字。 */
  function profileName(id: string, name: string): string {
    return id === 'default' ? t('keymap.profileDefault') : name
  }

  const appCommands = KEYMAP_COMMANDS.filter((c) => c.app)
  const scopedCommands = KEYMAP_COMMANDS.filter((c) => !c.app)
  const lines = summaryLines()

  return (
    <>
      <div className={s.sectionNote}>{t('keymap.hint')}</div>

      <div className={s.settingRow}>
        <div className={s.settingRowLabel}>{t('keymap.profileLabel')}</div>
        <div className={s.keyRight}>
          <Select
            label={t('keymap.profileLabel')}
            value={profile?.id ?? 'default'}
            options={listProfiles(keymap).map((p) => ({
              value: p.id,
              label: profileName(p.id, p.name),
            }))}
            onChange={(id) => {
              setProfile(id)
              setSummary(null)
            }}
          />
          <Button aria-label={t('keymap.import')} onClick={() => fileRef.current?.click()}>
            {t('keymap.import')}
          </Button>
          <Button aria-label={t('keymap.export')} onClick={onExport}>
            {t('keymap.export')}
          </Button>
          {/*
            * 文件选择器必须由一次**真实的用户手势**触发,所以它是这块面上的一个
            * DOM 节点(同 composer 的附件口),不是一只可以随时调的函数。
            */}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className={s.hiddenFile}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void onFile(file)
            }}
          />
        </div>
      </div>
      <div className={s.settingRowNote}>{t('keymap.profileNote')}</div>
      {lines.map((line, i) => (
        <div className={s.settingRowNote} key={i} role="status">
          {line}
        </div>
      ))}

      <h4 className={s.sectionTitle}>{t('keymap.sectionApp')}</h4>
      {appCommands.map(row)}

      <h4 className={s.sectionTitle}>{t('keymap.sectionScoped')}</h4>
      <div className={s.sectionNote}>{t('keymap.scopedNote2')}</div>
      {scopedCommands.map(row)}

      <div className={s.sectionNote}>{t('keymap.structuralNote')}</div>
    </>
  )
}
