import { describe, expect, it } from 'vitest'
import { NATIVE_VIEW_HOST_SCOPES, boundChordsFor, chordOfCombo } from '../keymap-downlink'
import { chordOf } from '../../../../electron/browser/keymap-bridge'
import { KEYMAP_COMMANDS, effectiveCombos } from '../../../keymap/transitions'
import { focusScopeAnswersOf } from '../../../focus/scopes'
import { TERMINAL_SUMMON_COMBOS, comboForPlatform } from '../../../keymap/commands'
import { platformOf } from '../../../keymap/platform'
import type { Combo, KeymapPlatform } from '../../../keymap/types'

/**
 * **两端要对同一个键说同一个名字**(B2 §9-1)。
 *
 * 判据的产地是主进程那一侧的 `chordOf`(`electron/browser/keymap-bridge.ts`):
 * 修饰键固定次序 `cmd → ctrl → alt → shift`、主键小写。这一组钉的是壳这一侧
 * 按同一套规则把 `Combo` 写成串 —— 尤其是**「主修饰键是哪一枚」必须在这里就
 * 解释掉**:主进程收到的是一次真按键(mac 上 `meta: true`),把 `ctrl` 原样推
 * 下去,mac 上一条写成 `{ctrl:true}` 的出厂绑定会永远对不上。
 */

describe('一条绑定 → 一个串', () => {
  it('主修饰键按平台落地:mac 写 cmd,其余写 ctrl', () => {
    expect(chordOfCombo({ meta: true, key: 'l' }, 'mac')).toBe('cmd+l')
    expect(chordOfCombo({ meta: true, key: 'l' }, 'other')).toBe('ctrl+l')
    // **一条写成 `ctrl` 的绑定在 mac 上按的是 ⌘** —— 两种拼法都读作「主修饰键」
    // (`matchCombo`,T1-fix)。
    expect(chordOfCombo({ ctrl: true, key: '`' }, 'mac')).toBe('cmd+`')
    expect(chordOfCombo({ ctrl: true, key: '`' }, 'other')).toBe('ctrl+`')
  })

  /**
   * **第三种拼法 `offHand`**(K2,`Combo.offHand`:「另一枚」)。它在这一侧也要
   * 按平台落地 —— mac 上「另一枚」就是 Ctrl,Win / Linux 上是 Win 键,而主进程
   * 把 `meta: true` 写成 `cmd`,所以那两台机器上串写 `cmd+…`。
   *
   * 反证:把 `chordOfCombo` 里那一句 `offHand` 拆掉 → ⌃Tab 写出 `tab`,主进程
   * 那张保留表里就永远没有它,于是**网页拿走了 ⌃Tab**(页面自己换标签),
   * 而壳这一侧的 ⌘⇧] 照常好使 —— 那是最难查的一类不一致。
   */
  it('`offHand`(另一枚)按平台落地:mac 写 ctrl,其余写 cmd', () => {
    expect(chordOfCombo({ offHand: true, key: 'tab' }, 'mac')).toBe('ctrl+tab')
    expect(chordOfCombo({ offHand: true, key: 'tab' }, 'other')).toBe('cmd+tab')
    expect(chordOfCombo({ offHand: true, shift: true, key: 'tab' }, 'mac')).toBe('ctrl+shift+tab')
    // 出厂的 `toggle:terminal`(K2 起是 `offHand`)在 mac 上是 ⌃ 反引号。
    expect(chordOfCombo({ offHand: true, key: '`' }, 'mac')).toBe('ctrl+`')
  })

  /**
   * **两端逐字相等**(K2 派工单 §5 点名的那一条)。左边是**声明** → 串,
   * 右边是**一次真按键** → 串;两串必须一个字都不差,否则主进程截不住
   * (或者截住了一个壳这边根本不认的键)。
   *
   * 主进程那一侧的 `chordOf` 是被直接 import 进来的同一只函数 —— 这一条因此
   * 不是「抄一份规则再比一次」,而是把两个真产地放在一起对。
   */
  it('两端对同一次真按键算出同一个串(offHand 那一族)', () => {
    const cases: Array<{
      combo: Combo
      platform: KeymapPlatform
      pressed: Parameters<typeof chordOf>[0]
    }> = [
      // mac:⌃Tab —— 真按键里 control 按着、meta 没按。
      { combo: { offHand: true, key: 'tab' }, platform: 'mac', pressed: { key: 'Tab', control: true } },
      {
        combo: { offHand: true, shift: true, key: 'tab' },
        platform: 'mac',
        pressed: { key: 'Tab', control: true, shift: true },
      },
      // mac:⌃ 反引号(`toggle:terminal` 的出厂键)。
      { combo: { offHand: true, key: '`' }, platform: 'mac', pressed: { key: '`', control: true } },
      // Win / Linux:Win+Tab —— 真按键里 meta 按着。
      { combo: { offHand: true, key: 'tab' }, platform: 'other', pressed: { key: 'Tab', meta: true } },
      // 主修饰那一族(K0 就成立,一并钉住:两端没有第二套规则)。
      { combo: { meta: true, shift: true, key: ']' }, platform: 'mac', pressed: { key: ']', meta: true, shift: true } },
      { combo: { meta: true, key: 't' }, platform: 'other', pressed: { key: 'T', control: true } },
    ]
    for (const row of cases) {
      expect(chordOfCombo(row.combo, row.platform)).toBe(chordOf(row.pressed))
    }
  })

  it('修饰键次序固定,主键小写', () => {
    expect(chordOfCombo({ meta: true, alt: true, shift: true, key: 'ArrowLeft' }, 'mac')).toBe(
      'cmd+alt+shift+arrowleft',
    )
    // 没有修饰键的那一档(今天表里没有,但写法要对)。
    expect(chordOfCombo({ key: 'F5' }, 'mac')).toBe('f5')
  })
})

describe('整表', () => {
  it('全局命令 ∪ 那几个作用域的局部键,去重且排序', () => {
    const chords = boundChordsFor(['browser'], { overrides: {} }, 'mac')
    // `browser` 那条局部键(⌘L)在表里 —— 它是保留键,得先于页面。
    expect(chords).toContain('cmd+l')
    // 全局命令也在(⌘⇧F 检索面 / ⌘E 会话总览;K2 起 ⌘P 出厂不绑)。
    expect(chords).toContain('cmd+shift+f')
    expect(chords).toContain('cmd+e')
    expect(chords).not.toContain('cmd+p')
    // 去重 + 排序:同一个串只出现一次,整表有序(两端比对的是集合)。
    expect(new Set(chords).size).toBe(chords.length)
    expect([...chords].sort()).toEqual(chords)
  })

  it('改绑跟着走 —— 表是从 `overrides` 现算的,不是一份快照', () => {
    const before = boundChordsFor([], { overrides: {} }, 'mac')
    const after = boundChordsFor([], { overrides: { 'toggle:search': [{ meta: true, key: 'k' }] } }, 'mac')
    expect(before).toContain('cmd+shift+f')
    expect(after).not.toContain('cmd+shift+f')
    expect(after).toContain('cmd+k')
  })

  it('解绑(`null`)的命令不进表 —— 那个组合该归页面', () => {
    const chords = boundChordsFor([], { overrides: { 'toggle:search': null } }, 'mac')
    expect(chords).not.toContain('cmd+shift+f')
  })

  it('表里每一条都真的对应一条**有绑定的应用级**命令(不多不少)', () => {
    /*
     * K0:进表的判据从「是不是全局命令」变成了**命令表上的两格数据**
     * (`nativeView === 'reserve'` ∧ 有绑定 ∧(`app` ∨ 在场的作用域答得出))。
     * 不给作用域时,进表的就只剩应用级那一族 —— `view.save` 这类跟随焦点的命令
     * 不该被推下去:查看器与那片原生视图不会同时在场,推下去只会让页面自己的
     * ⌘S 变成一个什么都不做的键。
     */
    const chords = new Set(boundChordsFor([], { overrides: {} }, 'mac'))
    const bound = KEYMAP_COMMANDS.filter(
      (c) => c.app && effectiveCombos({ overrides: {} }, c.id).length > 0,
    )
    for (const command of bound) {
      for (const combo of effectiveCombos({ overrides: {} }, command.id)) {
        expect(chords.has(chordOfCombo(combo, 'mac')), command.id).toBe(true)
      }
    }
    // 跟随焦点那一族,没有在场的作用域就一条都不进表。
    expect(chords.has('cmd+s')).toBe(false)
    expect(chords.has('cmd+i')).toBe(false)
  })

  /**
   * **那把尺子**:推下去的键集逐字写成字面量。**多一条**就是某个跟随焦点的命令
   * 被错误地下沉了(页面自己的那个键会变成哑键);**少一条**就是壳的某个保留键
   * 被让给了页面。
   *
   * ── K0 的十九条 → K2 的三十三条,差额逐条对得上 ─────────────────────────
   * **出去两条**:`cmd+p`(检索面让出 ⌘P,09-12 裁定 3)、`cmd+1/2/3` 里那三条
   * 工作区序号(出厂解绑,裁定 2)—— 一共四条。
   * **进来十八条**:`cmd+,`(⌘,开设置)、`cmd+1`…`cmd+9`(九格标签直达,裁定 2
   * 的另一半)、`cmd+shift+f`(检索面的新键)、`cmd+t` / `cmd+n` / `cmd+shift+t`
   * / `cmd+shift+]` / `cmd+shift+[` / `ctrl+tab` / `ctrl+shift+tab`(标签族)、
   * `cmd+w`(**这一条是 K2 才进来的**:它只有叶答得出,而叶从今天起在在场集合里
   * —— 判词整段在 `NATIVE_VIEW_HOST_SCOPES` 上)。
   * **换了一格写法**:`cmd+\`` → `ctrl+\``(`toggle:terminal` 改按平台分档 ——
   * 真机 mac 与真机 Win 上都是 `ctrl+\``,**同一个手势**;那一格因此不写字面量,
   * 判词在下面 `summonChordOn` 上)。
   *
   * 19 − 4 + 18 = 33。这一行算术就是这张表的审计。
   *
   * ── K2 的三十三条 → K3 的四十条 ─────────────────────────────────────────
   * **只进不出,七条**,而且七条全是**浏览器答得出的内容族命令**(K3):
   * `cmd+r`(`view.reload`)、`cmd+[` / `cmd+]`(`nav.back` / `nav.forward` ——
   * 从前只有检索面答,检索面与那片原生视图不会同时在场,所以它们在 K2 那张表上
   * 不在)、`cmd+=` 与 `cmd+shift++`(`view.zoomIn` 的两个键面 —— 同一枚物理键
   * 按不按 ⇧)、`cmd+-`(`view.zoomOut`)、`cmd+0`(`view.zoomReset`)。
   *
   * **它们必须进这张表**,而那正是 K3 的正题:K1 已经把 ⌘R / ⌘± / ⌘0 从
   * Electron 默认菜单手上拿走了,如果它们不在保留表里,页面焦点下按 ⌘R 就落回
   * 页面自己的重载 —— 那**看起来**是对的,但 ⌘[ / ⌘] / ⌘0 三条壳这一侧的响应者
   * 就永远轮不到,而「后退归浏览器叶」是这一单的裁定。
   *
   * 33 + 7 = 40。这一行算术就是这张表的审计。
   * 09-24 顶架子退役,`cmd+alt+arrowup` 随之出表:40 − 1 = 39。
   */
  const K2_BROWSER_CHORDS_MAC = [
    'cmd+,',
    'cmd+1',
    'cmd+2',
    'cmd+3',
    'cmd+4',
    'cmd+5',
    'cmd+6',
    'cmd+7',
    'cmd+8',
    'cmd+9',
    'cmd+alt+arrowdown',
    'cmd+alt+arrowleft',
    'cmd+alt+arrowright',
    'cmd+alt+shift+arrowleft',
    'cmd+alt+shift+arrowright',
    'cmd+e',
    'cmd+f',
    'cmd+j',
    'cmd+l',
    'cmd+n',
    'cmd+shift+[',
    'cmd+shift+]',
    'cmd+shift+enter',
    'cmd+shift+f',
    'cmd+shift+o',
    'cmd+shift+t',
    'cmd+shift+w',
    'cmd+t',
    'cmd+w',
    'ctrl+shift+tab',
    'ctrl+tab',
    /* ── K3 的七条(判词在上面那段算术里)────────────────────────────── */
    'cmd+[',
    'cmd+]',
    'cmd+=',
    'cmd+-',
    'cmd+0',
    'cmd+r',
    'cmd+shift++',
  ]

  /**
   * **召唤终端那一条不写成字面量**(K2 修一轮):它的出厂键**按平台分档**
   * (`commands.byPlatform`),而那一档是**模块加载时按跑用例这台机器**定的,
   * 与 `boundChordsFor` 收的那个 `platform` 参数是两回事 —— 生产上两者恒等
   * (真机 mac 上是 `ctrl+\``,真机 Win 上是 `ctrl+\``,**同一个手势**),
   * 用例里可能不等(jsdom 的 UA 不是 mac)。所以这一格跟着**声明**算,
   * 别的三十二条照旧逐字钉死。
   */
  const summonChordOn = (lane: KeymapPlatform) =>
    chordOfCombo(comboForPlatform(TERMINAL_SUMMON_COMBOS, platformOf(navigator.userAgent)), lane)

  it('推下去的键集逐字就是这三十九条(mac 档)', () => {
    const expected = [...K2_BROWSER_CHORDS_MAC, summonChordOn('mac')].sort()
    expect(boundChordsFor(['browser', ...NATIVE_VIEW_HOST_SCOPES], { overrides: {} }, 'mac')).toEqual(expected)
    expect(expected).toHaveLength(39)
  })

  /**
   * Win / Linux 档同一张表,**但不是一次 `cmd+` → `ctrl+` 的整体替换**:
   * `offHand`(「另一枚」)在两台机器上指的是两枚不同的键,所以它那三条反着走
   * (mac 的 `ctrl+…` 在那边是 `cmd+…`)。K0 那条 `.replace(/^cmd\+/, 'ctrl+')`
   * 因此不再成立 —— 它会把 ⌃Tab 说成 Win 上的 Ctrl+Tab,而那一枚在那边是主
   * 修饰键、归应用的别的命令。
   */
  it('Win / Linux 档:主修饰那一族换写法,`offHand` 那三条反着走', () => {
    const other = boundChordsFor(['browser', ...NATIVE_VIEW_HOST_SCOPES], { overrides: {} }, 'other')
    // 字面量那几条 + 召唤那一格(判词在 `summonChordOn` 上)。
    expect(other).toHaveLength(K2_BROWSER_CHORDS_MAC.length + 1)
    // 主修饰那一族:mac 的 `cmd+x` ↔ 别处的 `ctrl+x`。
    for (const chord of K2_BROWSER_CHORDS_MAC.filter((c) => c.startsWith('cmd+'))) {
      expect(other).toContain(chord.replace(/^cmd\+/, 'ctrl+'))
    }
    // `offHand` 那两条:mac 写 ctrl,别处写 cmd。
    expect(other).toContain('cmd+tab')
    expect(other).toContain('cmd+shift+tab')
    expect(other).not.toContain('ctrl+tab')
    // 召唤终端那一条跟着**声明**走(判词在 `summonChordOn` 上)。
    expect(other).toContain(summonChordOn('other'))
  })

  /**
   * **叶补进在场集合之后,⌘T / ⌘W 那一族才到得了主进程**(K2)。
   * 拆掉 `NATIVE_VIEW_HOST_SCOPES` → 这一条红,而真机门 `gate:browser` 那一步
   * 「页面焦点下 ⌘T 开出一格新标签」同时红。
   */
  it('只报 `browser` 一格时,叶那一族一条都不在表里(所以宿主那一格必须补)', () => {
    const withoutLeaf = boundChordsFor(['browser'], { overrides: {} }, 'mac')
    expect(withoutLeaf).not.toContain('cmd+t')
    expect(withoutLeaf).not.toContain('cmd+w')
    expect(withoutLeaf).not.toContain('ctrl+tab')
    expect(NATIVE_VIEW_HOST_SCOPES).toEqual(['leaf'])
  })

  it('这八条进表是因为 `browser` **答得出**它们,不是因为它叫 browser', () => {
    // 拆掉 `BROWSER_ANSWERS` 里任意一条 → 这一条与上面那张字面量表一起红。
    expect(focusScopeAnswersOf('browser').map((a) => a.command)).toEqual([
      'browser.address',
      'view.find',
      /* ── 内容族六条(K3)────────────────────────────────────────────── */
      'view.reload',
      'nav.back',
      'nav.forward',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomReset',
    ])
    const without = boundChordsFor([], { overrides: {} }, 'mac')
    expect(without).not.toContain('cmd+l')
    expect(without).not.toContain('cmd+f')
    /*
     * **内容族那七个键面没有 `browser` 在场时一个都不进表**,而这一句比
     * 「⌘L 不在」更值钱:它们全都落在 `KEYS_RESERVED_FOR_CONTENT`(K1)或
     * 它旁边 —— 在没有网页的时候把 ⌘R 推下去,等于替一个不存在的响应者
     * 占着一个键。
     */
    for (const chord of ['cmd+r', 'cmd+[', 'cmd+]', 'cmd+=', 'cmd+-', 'cmd+0', 'cmd+shift++']) {
      expect(without, chord).not.toContain(chord)
    }
  })
})

describe('键位下沉:表跟着**键位组**走(K5)', () => {
  /*
   * 有效键是三层落出来的,所以这只函数收的是**整份状态**而不是 `overrides` 一格。
   * 只递那一格的话,换到 VS Code 组之后推给主进程的还是出厂那张表 —— 网页里按
   * ⌘⇧P 会落到页面自己手里,而设置页上明明写着它是命令面板。真机那一半由
   * `gate:browser` ㉓ 守着。
   */
  it('换到 VS Code 组:⌘⇧P 进表、出厂那个 ⌘⇧W 出表', () => {
    const factory = boundChordsFor([], { overrides: {} }, 'mac')
    expect(factory).toContain('cmd+shift+w')
    expect(factory).not.toContain('cmd+shift+p')
    const vscode = boundChordsFor([], { overrides: {}, profileId: 'vscode' }, 'mac')
    expect(vscode).toContain('cmd+shift+p')
    expect(vscode).not.toContain('cmd+shift+w')
  })

  it('用户逐格覆盖仍然赢组(三层的最上面那一层照样下沉)', () => {
    const mine = boundChordsFor(
      [],
      { overrides: { 'workspace.palette': [{ meta: true, alt: true, key: 'y' }] }, profileId: 'vscode' },
      'mac',
    )
    expect(mine).toContain('cmd+alt+y')
    expect(mine).not.toContain('cmd+shift+p')
  })
})
