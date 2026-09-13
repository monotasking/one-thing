import { chordOfCombo, comboOfChord } from './chord'
import { KEYMAP_COMMANDS, findCommand } from './commands'
import { effectiveCombos } from './transitions'
import { USER_PROFILE_ID_PREFIX } from './profiles'
import type { KeymapProfile } from './profiles'
import type { Combo, CommandId, KeymapPlatform, KeymapState } from './types'

/**
 * **键位组的文件形**(K5):导入 / 导出走的那份 JSON,以及读它的报告。
 *
 * ── 文件长什么样 ────────────────────────────────────────────────────────
 * ```json
 * {
 *   "name": "我的键位",
 *   "bindings": {
 *     "tab.close":     "cmd+w",
 *     "tab.next":      ["cmd+shift+]", "ctrl+tab"],
 *     "toggle:search": null
 *   }
 * }
 * ```
 * 值有三种,三种都是**话**:一个串 = 绑这一个键;一串串 = 这一条有好几个键面;
 * `null` = 这一组把它解绑了。键写成 `chord.ts` 那份规范串 —— **与推给主进程的
 * 保留键表同一份写法**,不是第二种拼法。
 *
 * ── 读一份别人的文件,最要紧的是**说得出哪一行没读懂** ────────────────────
 * 所以这只文件回的不是「成功 / 失败」,是一份**报告**:认不出的命令 id 逐条列、
 * 读不出的键串逐条列、真正生效了几条。用户据此知道自己那份文件哪一行白写了,
 * 而不是对着一个「导入成功」猜为什么某个键没变。静默吞掉一行是这类功能最典型
 * 的病(同 `bindCombo` 那条「冲突不静默覆盖」的判词)。
 *
 * ── 用户组的 id 由**这里**铸,不由文件说了算 ──────────────────────────────
 * 一律 `user:` 打头(`USER_PROFILE_ID_PREFIX`),于是一份文件写 `"id": "default"`
 * 也盖不住内置组 —— 那不是校验,那是**结构**。同名再导入一次 = 同 id,
 * `addUserProfile` 当场覆盖(更新那一份,不是堆一摞)。
 */

/** 文件里 `bindings` 一格的值:一个键 / 好几个键 / 显式解绑。 */
type BindingValue = string | readonly string[] | null

export interface KeymapProfileFile {
  id?: string
  name?: string
  bindings?: Record<string, BindingValue>
}

/** 读一份文件的报告。`profile` 为 null = 整份都没读成(`error` 说是哪一种)。 */
export interface ProfileImportReport {
  profile: KeymapProfile | null
  /** `json` = 不是合法 JSON;`shape` = 是 JSON 但不是一份键位组。 */
  error?: 'json' | 'shape'
  /** 真正生效了几条命令。 */
  accepted: number
  /** 认不出的命令 id(这台壳没有这条命令)。 */
  unknownCommands: string[]
  /** 读不出的键串(哪一条命令上的哪一个串)。 */
  badChords: Array<{ command: string; chord: string }>
}

/**
 * 用户组的 id:`user:` + 文件自己说的 id 或名字。判词见文件头。
 *
 * **已经带着前缀的不再包一层** —— 导出的文件里 `id` 写的就是 `user:我的键位`,
 * 把它原样导回来该是同一组(于是同 id 覆盖那条规则生效,而不是每导一次多一组
 * `user:user:…`)。
 */
export function userProfileIdOf(seed: string): string {
  const trimmed = seed.trim().replace(/^(?:user:)+/, '')
  return USER_PROFILE_ID_PREFIX + (trimmed === '' ? 'imported' : trimmed)
}

/**
 * 读一份键位组文件。**认得出的生效,认不出的列出来** —— 一行读不懂不该让整份
 * 文件作废(用户手写的文件里错一个字是常事),但也不许悄悄跳过。
 *
 * 整份读不成只有两种:不是 JSON、或者不是一个带 `bindings` 的对象。
 */
export function parseProfileJson(
  text: string,
  platform: KeymapPlatform,
  fallbackName: string,
): ProfileImportReport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { profile: null, error: 'json', accepted: 0, unknownCommands: [], badChords: [] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { profile: null, error: 'shape', accepted: 0, unknownCommands: [], badChords: [] }
  }
  const file = raw as KeymapProfileFile
  const table = file.bindings
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    return { profile: null, error: 'shape', accepted: 0, unknownCommands: [], badChords: [] }
  }

  const bindings: KeymapProfile['bindings'] = {}
  const unknownCommands: string[] = []
  const badChords: Array<{ command: string; chord: string }> = []
  let accepted = 0

  for (const [command, value] of Object.entries(table)) {
    if (!findCommand(command as CommandId)) {
      unknownCommands.push(command)
      continue
    }
    if (value === null) {
      bindings[command as CommandId] = null
      accepted += 1
      continue
    }
    const chords = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
    if (!chords) {
      badChords.push({ command, chord: String(value) })
      continue
    }
    const combos: Combo[] = []
    for (const chord of chords) {
      const combo = typeof chord === 'string' ? comboOfChord(chord, platform) : null
      if (combo) combos.push(combo)
      else badChords.push({ command, chord: String(chord) })
    }
    /*
     * 一条命令上**一个键都没读出来**时不写这一格:写个空数组等于替用户说
     * 「解绑」,而他的意思是「这几个串我写错了」。缺席才是实话 —— 那一条落回
     * 出厂值,并且已经逐条列在 `badChords` 里。
     */
    if (combos.length === 0) continue
    bindings[command as CommandId] = combos
    accepted += 1
  }

  const name = (file.name ?? '').trim() || fallbackName
  return {
    profile: { id: userProfileIdOf(file.id ?? name), name, bindings },
    accepted,
    unknownCommands,
    badChords,
  }
}

/**
 * **当前有效表整张写成一组**(导出)。
 *
 * 写的是三层落完之后那张表(覆盖 ▷ 当前组 ▷ 出厂),所以导出的是「我这台机器
 * 现在的手」,不是「我改过哪几格」—— 后者换一台机器就对不上了(那边的当前组
 * 可能是另一组)。没绑键的命令写成显式 `null`,于是**导回来一模一样**:
 * 缺席会落回出厂值,而「它此刻确实没绑」是一句要被保下来的话。
 */
export function profileFromState(state: KeymapState, name: string): KeymapProfile {
  const bindings: KeymapProfile['bindings'] = {}
  for (const command of KEYMAP_COMMANDS) {
    const combos = effectiveCombos(state, command.id)
    bindings[command.id] = combos.length === 0 ? null : combos.map((c) => ({ ...c }))
  }
  return { id: userProfileIdOf(name), name, bindings }
}

/** 一组 → 文件正文。两个空格缩进:这份文件是给人读、给人手改的。 */
export function serializeProfile(profile: KeymapProfile, platform: KeymapPlatform): string {
  const bindings: Record<string, BindingValue> = {}
  for (const [command, combos] of Object.entries(profile.bindings)) {
    bindings[command] = combos === null || combos === undefined
      ? null
      : combos.map((c) => chordOfCombo(c, platform))
  }
  const file: KeymapProfileFile = { id: profile.id, name: profile.name, bindings }
  return `${JSON.stringify(file, null, 2)}\n`
}
