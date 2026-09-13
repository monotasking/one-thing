import { comboOfChord } from './chord'
import { findCommand } from './commands'
import { userProfileIdOf } from './profile-io'
import type { KeymapProfile } from './profiles'
import type { Combo, CommandId, KeymapPlatform } from './types'

/**
 * **吃一份 VS Code 的 `keybindings.json`**(K5,方案 §5 K5 的「第二种入口」)。
 *
 * ── 它为什么是**转换器**,不是「直接吃」 ─────────────────────────────────
 * 方案里那句原话:VS Code 的 `command` 名与 `when` 子句是 VS Code 的世界,硬映射
 * 只会得到一堆「没有对应命令」的行。所以这只文件做三件事,每一件都**说得出口**:
 *  · `command` 按一张对照表换成这台壳的 `CommandId` —— 表就是 `profiles.ts` 里
 *    VS Code 组那一张的**反向**(用例钉着两张表互为反函数:那边多一行、这边
 *    不跟,当场红);
 *  · `key` 按 VS Code 的写法解析成 `Combo`(它的修饰键别名与键名与这台壳不同,
 *    归一在这只文件里,`chord.ts` 那份规范一个字不改);
 *  · `when` **忽略,但逐行列出来** —— 「这一行只在某个上下文里生效,我照单全收了」
 *    必须让用户看见。悄悄把一条带 `when` 的绑定变成无条件的全局键是这类导入最
 *    危险的一种静默。
 * 认不出的 `command` 原样列出,一行都不猜。
 *
 * ── 一格交代清楚的取舍:`ctrl` 在 mac 上读作哪一枚 ────────────────────────
 * VS Code 的 `keybindings.json` 是**每台机器自己的**文件:mac 上那份里的 `ctrl`
 * 指的就是 Ctrl 那一枚物理键(= 这台壳的「另一枚」),`cmd` 才是主修饰键。所以
 * 解析按**当下这台机器**的读法走(`chord.ts` 的 `comboOfChord`)。把一份
 * Windows 上写的文件导到 mac 上,`ctrl+…` 会读成 ⌃…(而不是 ⌘…)—— 那是
 * 逐字忠实于文件的读法,不是错;要的是 ⌘ 就在设置页上改那一格。
 */

/** VS Code 命令名 → 这台壳的命令 id。`profiles.ts` 里 vscode 组那张表的反向。 */
const VSCODE_COMMANDS: Record<string, CommandId> = {
  'workbench.action.findInFiles': 'toggle:search',
  'workbench.action.showCommands': 'workspace.palette',
  'workbench.action.nextEditor': 'tab.next',
  'workbench.action.previousEditor': 'tab.prev',
  'workbench.action.reopenClosedEditor': 'tab.reopen',
  'workbench.action.closeActiveEditor': 'tab.close',
  'actions.find': 'view.find',
  'workbench.action.gotoLine': 'viewer.gotoLine',
  'workbench.action.terminal.toggleTerminal': 'toggle:terminal',
  'workbench.action.openSettings': 'toggle:settings',
}

/** 这台壳认得的 VS Code 命令名(用例拿它与 vscode 组对账)。 */
export const VSCODE_COMMAND_NAMES: readonly string[] = Object.keys(VSCODE_COMMANDS)

/** VS Code 的修饰键别名 → `chord.ts` 认的那四个词。 */
const MODIFIER_ALIASES: Record<string, string> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  win: 'cmd',
  super: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
}

/**
 * VS Code 的键名 → `KeyboardEvent.key` 的规范形(这台壳全仓认的那一份)。
 * 表里没有的单字符键(字母 / 数字 / 标点)原样落,认不出的长名字(`oem_4`)
 * 就是读不出 —— 列出来,不猜。
 */
const KEY_NAMES: Record<string, string> = {
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  space: ' ',
  escape: 'escape',
  esc: 'escape',
  enter: 'enter',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  insert: 'insert',
}

export interface VscodeImportReport {
  /** 读成的那一组。null = 整份都没读成(`error` 说是哪一种)。 */
  profile: KeymapProfile | null
  /** `json` = 不是合法 JSON(注释与末尾逗号已经先剥掉了);`shape` = 不是一个数组。 */
  error?: 'json' | 'shape'
  /** 真正生效了几条命令(合并之后的条数,不是文件行数)。 */
  accepted: number
  /** 认不出的 VS Code 命令名,去重。 */
  unknownCommands: string[]
  /** 读不出的 `key`(含组合序列 `ctrl+k ctrl+s` 那一档)。 */
  badKeys: Array<{ command: string; key: string }>
  /** `when` 被忽略的那几行,逐行列出。 */
  ignoredWhen: Array<{ command: string; key: string; when: string }>
}

interface VscodeRow {
  key?: unknown
  command?: unknown
  when?: unknown
}

export function importVscodeKeybindings(
  text: string,
  platform: KeymapPlatform,
  name: string,
): VscodeImportReport {
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonc(text))
  } catch {
    return { profile: null, error: 'json', accepted: 0, unknownCommands: [], badKeys: [], ignoredWhen: [] }
  }
  if (!Array.isArray(raw)) {
    return { profile: null, error: 'shape', accepted: 0, unknownCommands: [], badKeys: [], ignoredWhen: [] }
  }

  const bindings: KeymapProfile['bindings'] = {}
  const unknown = new Set<string>()
  const badKeys: Array<{ command: string; key: string }> = []
  const ignoredWhen: Array<{ command: string; key: string; when: string }> = []

  for (const entry of raw as VscodeRow[]) {
    if (!entry || typeof entry !== 'object') continue
    const command = typeof entry.command === 'string' ? entry.command : ''
    const key = typeof entry.key === 'string' ? entry.key : ''
    if (command === '') continue
    const id = VSCODE_COMMANDS[command]
    if (!id || !findCommand(id)) {
      unknown.add(command)
      continue
    }
    if (typeof entry.when === 'string' && entry.when.trim() !== '') {
      ignoredWhen.push({ command, key, when: entry.when })
    }
    const combo = comboOfVscodeKey(key, platform)
    if (!combo) {
      badKeys.push({ command, key })
      continue
    }
    /*
     * 同一条命令在文件里出现好几行 = 好几个键面(VS Code 自己就这么写
     * `nextEditor`)。**追加**而不是后来者覆盖 —— 与 `bindCombo` 的追加同一句话。
     */
    const had = bindings[id]
    bindings[id] = had ? [...had, combo] : [combo]
  }

  return {
    profile: { id: userProfileIdOf(name), name, bindings },
    accepted: Object.keys(bindings).length,
    unknownCommands: [...unknown],
    badKeys,
    ignoredWhen,
  }
}

/**
 * 一个 VS Code 的 `key` 串 → 一条绑定。
 *
 * **组合序列读不出**:VS Code 的 `"ctrl+k ctrl+s"` 是「先按这个再按那个」,
 * 这台壳的表里没有这种东西(一条绑定就是一下)。它不是错字,是一种表达不出来
 * 的东西 —— 所以列进 `badKeys` 给用户看,不截断成第一下(那会悄悄绑出一个他
 * 没要的键)。
 */
function comboOfVscodeKey(key: string, platform: KeymapPlatform): Combo | null {
  const text = key.trim().toLowerCase()
  if (text === '' || /\s/.test(text)) return null
  const split = splitVscodeKey(text)
  if (!split) return null
  const parts: string[] = []
  for (const mod of split.mods) {
    const canonical = MODIFIER_ALIASES[mod]
    if (!canonical) return null
    parts.push(canonical)
  }
  const mapped = KEY_NAMES[split.key] ?? (split.key.length === 1 || /^f\d{1,2}$/.test(split.key) ? split.key : null)
  if (mapped === null) return null
  parts.push(mapped)
  return comboOfChord(parts.join('+'), platform)
}

/** 拆 `key`。与 `chord.ts` 的 `splitChord` 同一条判词:末位的 `+` 是键不是分隔符。 */
function splitVscodeKey(text: string): { mods: string[]; key: string } | null {
  if (text === '+') return { mods: [], key: '+' }
  if (text.endsWith('+')) {
    const head = text.slice(0, -1)
    if (!head.endsWith('+')) return null
    return { mods: head.slice(0, -1).split('+').filter(Boolean), key: '+' }
  }
  const parts = text.split('+')
  const key = parts.pop()
  if (!key) return null
  return { mods: parts.filter(Boolean), key }
}

/**
 * 剥注释与末尾逗号(JSONC → JSON)。
 *
 * 不是洁癖:VS Code 那份文件**第一行就是注释**(「Place your key bindings in
 * this file to override the defaults」),不剥的话真机上导入永远第一步就失败。
 * 字符串里的 `//` 与 `/*` 不算注释,所以这里是个小扫描器而不是一条正则 ——
 * 一条正则会把 `"key": "ctrl+/"` 之后的半行吃掉。
 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  /* 末尾逗号:`, ]` / `, }` —— 注释剥完之后才好判(注释里也可能有逗号)。 */
  return out.replace(/,(\s*[\]}])/g, '$1')
}
