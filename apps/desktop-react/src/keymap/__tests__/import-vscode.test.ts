import { describe, expect, it } from 'vitest'
import { VSCODE_COMMAND_NAMES, importVscodeKeybindings, stripJsonc } from '../import-vscode'
import { keymapProfilesFor } from '../profiles'
import type { CommandId } from '../types'

/**
 * **VS Code `keybindings.json` 转换器**(K5,方案 §5 K5 的「第二种入口」)。
 *
 * 两件事在这儿钉着:
 *  ① 对照表与 `profiles.ts` 里 VS Code 组那张表**互为反函数** —— 两张表是同一份
 *    知识的两种用法,加一行要两边一起加。用例一红就是「有人只改了一边」;
 *  ② 一份**真实形状**的文件(带头部注释、带 `when`、带认不出的命令、带组合序列)
 *    进去之后,认得出的生效,读不懂的**逐行说得出口**。
 */

const MAC = 'mac' as const

/** 一份形状像真的样例:JSONC 头注释 + 末尾逗号 + 四种行各一条。 */
const SAMPLE = `// Place your key bindings in this file to override the defaults
[
  { "key": "cmd+shift+p", "command": "workbench.action.showCommands" },
  { "key": "ctrl+\`",     "command": "workbench.action.terminal.toggleTerminal" },
  { "key": "cmd+f",       "command": "actions.find", "when": "editorFocus" },
  { "key": "cmd+k cmd+s", "command": "workbench.action.openGlobalKeybindings" },
  { "key": "cmd+shift+e", "command": "workbench.view.explorer" },
  { "key": "hyper+z",     "command": "workbench.action.closeActiveEditor" },
]
`

describe('VS Code 转换器', () => {
  it('对照表与 vscode 组互为反函数(改一边不改另一边当场红)', () => {
    const vscode = keymapProfilesFor('mac').find((p) => p.id === 'vscode')
    const ours = new Set(Object.keys(vscode?.bindings ?? {}))
    const mapped = new Set<CommandId>()
    for (const name of VSCODE_COMMAND_NAMES) {
      const report = importVscodeKeybindings(
        JSON.stringify([{ key: 'cmd+f1', command: name }]),
        MAC,
        'x',
      )
      const ids = Object.keys(report.profile?.bindings ?? {}) as CommandId[]
      expect(ids, name).toHaveLength(1)
      mapped.add(ids[0])
    }
    expect([...mapped].sort()).toEqual([...ours].sort())
  })

  it('认得出的生效,认不出的原样列出来', () => {
    const report = importVscodeKeybindings(SAMPLE, MAC, '我的 VS Code')
    expect(report.error).toBeUndefined()
    expect(report.profile?.name).toBe('我的 VS Code')
    expect(report.profile?.bindings['workspace.palette']).toEqual([
      { meta: true, shift: true, key: 'p' },
    ])
    /* mac 上 VS Code 的 `ctrl` 指的就是 Ctrl 那一枚物理键 = 这台壳的「另一枚」。 */
    expect(report.profile?.bindings['toggle:terminal']).toEqual([{ offHand: true, key: '`' }])
    expect(report.unknownCommands.sort()).toEqual([
      'workbench.action.openGlobalKeybindings',
      'workbench.view.explorer',
    ])
    expect(report.accepted).toBe(3)
  })

  it('`when` 忽略,但**逐行列出来**(悄悄变成无条件全局键是最危险的一种静默)', () => {
    const report = importVscodeKeybindings(SAMPLE, MAC, 'x')
    expect(report.ignoredWhen).toEqual([
      { command: 'actions.find', key: 'cmd+f', when: 'editorFocus' },
    ])
    // 忽略归忽略,那一行照样生效。
    expect(report.profile?.bindings['view.find']).toEqual([{ meta: true, key: 'f' }])
  })

  it('读不出的 key 列出来:hyper 这种修饰键、以及**组合序列**(先按这个再按那个)', () => {
    const report = importVscodeKeybindings(SAMPLE, MAC, 'x')
    expect(report.badKeys).toEqual([{ command: 'workbench.action.closeActiveEditor', key: 'hyper+z' }])
    /*
     * `cmd+k cmd+s` 那一行的命令本来就认不出,所以它进的是 unknownCommands。
     * 序列这一档单独验一遍:命令认得出、键读不出 —— 不许截断成第一下。
     */
    const seq = importVscodeKeybindings(
      JSON.stringify([{ key: 'cmd+k cmd+s', command: 'actions.find' }]),
      MAC,
      'x',
    )
    expect(seq.badKeys).toEqual([{ command: 'actions.find', key: 'cmd+k cmd+s' }])
    expect(seq.accepted).toBe(0)
  })

  it('同一条命令在文件里出现好几行 = 好几个键面(追加,不是后来者覆盖)', () => {
    const report = importVscodeKeybindings(
      JSON.stringify([
        { key: 'alt+cmd+right', command: 'workbench.action.nextEditor' },
        { key: 'cmd+shift+]', command: 'workbench.action.nextEditor' },
      ]),
      MAC,
      'x',
    )
    expect(report.profile?.bindings['tab.next']).toEqual([
      { meta: true, alt: true, key: 'arrowright' },
      { meta: true, shift: true, key: ']' },
    ])
  })

  it('整份读不成时说清是哪一种', () => {
    expect(importVscodeKeybindings('[', MAC, 'x').error).toBe('json')
    expect(importVscodeKeybindings('{"a":1}', MAC, 'x').error).toBe('shape')
  })
})

describe('JSONC:剥注释不许伤到字符串', () => {
  it('字符串里的 // 与 /* 不是注释', () => {
    const text = '[{ "key": "cmd+/", "command": "actions.find" }]'
    expect(stripJsonc(text)).toBe(text)
    const report = importVscodeKeybindings(text, MAC, 'x')
    expect(report.profile?.bindings['view.find']).toEqual([{ meta: true, key: '/' }])
  })

  it('行注释、块注释与末尾逗号都剥得掉', () => {
    expect(stripJsonc('[1, /* two */ 2, ] // tail')).toBe('[1,  2 ] ')
  })
})
