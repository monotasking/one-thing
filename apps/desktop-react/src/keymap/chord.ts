import type { Combo, KeymapPlatform } from './types'

/**
 * **一条绑定的规范串**,两个方向(K5)。
 *
 * ── 这只文件为什么存在 ──────────────────────────────────────────────────
 * 「⌘⇧F 写成 `cmd+shift+f`」这句话原先只有**一个方向**、而且住在
 * `content/native-view/keymap-downlink.ts` 里 —— 那只文件的职责是「把保留键表
 * 推给主进程」,串只是它的中间产物。K5 要把同一句话用在**文件**上(导入 / 导出
 * 的键位组 JSON 里,每条绑定写成一个串),于是需要**反过来**读回来。
 *
 * 一个只能正着走的函数不是一份规范,是一次输出。所以两向落在同一只文件里,
 * 挨着写、一起测(`__tests__/chord.test.ts` 的互逆用例):改了写法,读法当场红。
 * `keymap-downlink` 把 `chordOfCombo` 原样再导出,既有调用点一个字不用改。
 *
 * ── 规范本身(判据住在主进程,这里是同一套规则的另一次调用)──────────────
 * 产地是 `electron/browser/keymap-bridge.ts` 的 `chordOf`:修饰键固定次序
 * `cmd → ctrl → alt → shift`、主键小写。主进程收到一次**真按键**时按这套规则算
 * 一遍,两串逐字比对 —— 所以这一侧写出去的串必须**已经解释过平台**:
 *
 *  · **主修饰键**(`meta` 与 `ctrl` 两种拼法,同一件事):mac 写 `cmd`,其余写 `ctrl`;
 *  · **另一枚**(`offHand`,判词在 `Combo.offHand` 上):mac 上它是 Ctrl,所以写
 *    `ctrl`;Win / Linux 上它是 Win 键,而主进程把 `meta: true` 写成 `cmd`,
 *    所以写 `cmd`。
 *
 * 两枚永不同时占用(一条绑定要么要主修饰键、要么要另一枚),所以 `cmd` 与 `ctrl`
 * 这两个位子在一个串里最多出现一个 —— 反着读因此不会有歧义。
 */

/** 规范串里认识的四个修饰键词。别的词一律读不出 —— 不猜。 */
const MODIFIER_TOKENS = new Set(['cmd', 'ctrl', 'alt', 'shift'])

/** 一条绑定 → 主进程认的那个串。与 `chordOf` 同一套规则(见文件头)。 */
export function chordOfCombo(combo: Combo, platform: KeymapPlatform): string {
  const parts: string[] = []
  const primary = combo.meta === true || combo.ctrl === true
  if (primary) parts.push(platform === 'mac' ? 'cmd' : 'ctrl')
  if (combo.offHand === true) parts.push(platform === 'mac' ? 'ctrl' : 'cmd')
  if (combo.alt === true) parts.push('alt')
  if (combo.shift === true) parts.push('shift')
  parts.push(combo.key.toLowerCase())
  return parts.join('+')
}

/**
 * 串 → 一条绑定。读不出就是 `null` —— **不猜**:导入一份别人的文件时,
 * 「这一行我读不懂」必须能被列出来给用户看,而一个瞎猜出来的组合是说不出口的。
 *
 * 读不出的三种:空串 / 认不出的修饰键词(`hyper+f`)/ 没有主键(`cmd+`)。
 * 修饰键的**次序不管**(`shift+cmd+]` 与 `cmd+shift+]` 读成同一条)——
 * 次序是写出去那一侧的规范,读进来这一侧宽容,两者不矛盾:互逆用例钉的是
 * 「写出去再读回来 `sameCombo`」与「读进来再写出去逐字相等(规范次序)」。
 */
export function comboOfChord(chord: string, platform: KeymapPlatform): Combo | null {
  const split = splitChord(chord)
  if (!split) return null
  const combo: Combo = { key: split.key }
  for (const token of split.mods) {
    if (!MODIFIER_TOKENS.has(token)) return null
    if (token === 'alt') combo.alt = true
    else if (token === 'shift') combo.shift = true
    else if (token === (platform === 'mac' ? 'cmd' : 'ctrl')) {
      /* 主修饰键。串里已经解释过平台,所以读回来固定写 `meta`(声明侧两种
       * 拼法同义,`sameCombo` 判它们相等)。 */
      combo.meta = true
    } else {
      /* 剩下的那一个就是「另一枚」:mac 上的 `ctrl`、其余平台上的 `cmd`。 */
      combo.offHand = true
    }
  }
  /* 两枚都要的组合这台壳不收(判词在 `Combo.offHand` 上)—— 读出来当场判废。 */
  if (combo.meta === true && combo.offHand === true) return null
  return combo
}

/**
 * 拆串。**主键本身是 `+` 的那一档**要单独认(`cmd++` 的末位那个 `+` 是键,
 * 不是分隔符)—— 不认的话「⌘+」这条绑定写出去就再也读不回来。
 */
function splitChord(chord: string): { mods: string[]; key: string } | null {
  const text = chord.trim().toLowerCase()
  if (!text) return null
  if (text === '+') return { mods: [], key: '+' }
  if (text.endsWith('+')) {
    const head = text.slice(0, -1)
    if (!head.endsWith('+')) return null // `cmd+` = 缺主键
    return { mods: head.slice(0, -1).split('+').filter(Boolean), key: '+' }
  }
  const parts = text.split('+')
  const key = parts.pop()
  if (!key) return null
  return { mods: parts.filter(Boolean), key }
}
