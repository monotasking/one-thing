import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KEY_SCOPES,
  SCOPED_KEYS,
  comboFromChord,
  scopedCollisionsOf,
  scopedKeysOf,
} from '../scopes'
import { KEYMAP_COMMANDS, effectiveCombo, sameCombo } from '../transitions'
import { keymapById } from '../../content/viewer/registry'
import '../../content/viewer/keymaps'
import type { Combo } from '../types'

/**
 * **快捷键三层立法的守卫**(09-01 报障:「快捷键要分清局部和全局」)。
 *
 * 三层是:① 全局档(KEYMAP_COMMANDS,可改绑)② 面域局部键(scopes.ts 这张表)
 * ③ 行内结构键(方向键 / ↵,不进任何表)。这一组守的是**中间那一层不撒谎**:
 * 表上写着的键,那块面里真接着;那块面接着的键,表上真写着。
 *
 * 反证纪律:把 `SCOPED_KEYS` 里查看器那三行删掉一行 → 第一条当场红;
 * 把 `content/viewer/keymaps.ts` 的 `mod+f` 删掉 → 同一条从另一头红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '../..')

function key(combo: Combo): string {
  return [combo.meta || combo.ctrl ? 'mod' : '', combo.shift ? 'shift' : '', combo.alt ? 'alt' : '', combo.key]
    .filter(Boolean)
    .join('+')
}

describe('面域局部键:声明与落点不许分叉', () => {
  it('查看器那一格 = 它默认键位档里的全部绑定,一条不多一条不少', () => {
    const declared = scopedKeysOf('viewer').map((k) => key(k.combo)).sort()
    const wired = Object.keys(keymapById('default')?.bindings ?? {}).sort()
    expect(declared).toEqual(wired)
  })

  it('每一条声明都写得出组合(chord 与 Combo 两种写法折成同一个形状)', () => {
    for (const chord of Object.keys(keymapById('default')?.bindings ?? {})) {
      const combo = comboFromChord(chord)
      expect(SCOPED_KEYS.some((k) => sameCombo(k.combo, combo))).toBe(true)
    }
  })

  it('文件行那一格真的长在行上 —— 源码里那段 keydown 认得出 ⌘I 与 ⌘↵', () => {
    /*
     * 这一条按**源文本**验,不按渲染验:那段 keydown 是行组件自己的一句
     * `if ((e.key === 'i' …) && (e.metaKey || e.ctrlKey))`,渲染层测得到的是
     * 「按 ⌘I 出详情」(那条断言在 files-panel 里),而这里要守的是
     * **表上那两行没有变成孤儿声明**。删掉行上那段判断 → 这一条红。
     *
     * 09-02 批 9d:那一行搬出了 `content/FilesPanel.tsx`(职责拆分),所以这里
     * 读的路径跟着改成它的新家 —— **两条正则一个字没动**。换的是文件不是约定:
     * 「声明与落点不许分叉」这条守卫认的始终是那段 keydown 本身在哪儿。
     */
    const source = readFileSync(path.join(srcRoot, 'content/files/TreeEntryRow.tsx'), 'utf-8')
    expect(source).toMatch(/e\.key === 'i'/)
    expect(source).toMatch(/e\.key === 'Enter'/)
    expect(scopedKeysOf('files.row').map((k) => key(k.combo)).sort()).toEqual([
      'mod+enter',
      'mod+i',
    ])
  })

  it('每个面域都在 KEY_SCOPES 里有名字(表里不许有无主的 scope)', () => {
    const known = new Set(KEY_SCOPES.map((s) => s.id))
    for (const scoped of SCOPED_KEYS) expect(known.has(scoped.scope)).toBe(true)
  })
})

describe('撞键:局部先接,没接住放行全局', () => {
  it('出厂表下 ⌘I / ⌘F 都没有全局命令占着 —— 今天零撞车', () => {
    expect(scopedCollisionsOf({ overrides: {} })).toEqual([])
  })

  it('用户把某条命令改绑到 ⌘I:撞车**说得出口**(而不是静默盖住行内键)', () => {
    const state = { overrides: { 'toc.toggle': { meta: true, key: 'i' } as Combo } }
    const collisions = scopedCollisionsOf(state)
    expect(collisions.map((c) => c.command)).toEqual(['toc.toggle'])
    expect(collisions[0].scoped.scope).toBe('files.row')
    /*
     * 撞车**不是错误**:局部先接、没接住放行,两者可以共存(⌘I 在文件行上开详情,
     * 在别处仍然是那条全局命令)。所以 `bindCombo` 的口径一个字不改 —— 它拦的是
     * 全局与全局的撞车,那种撞车才是真的「有一个按不响」。
     */
    expect(KEYMAP_COMMANDS.some((c) => c.id === 'toc.toggle')).toBe(true)
    expect(effectiveCombo(state, 'toc.toggle')).toEqual({ meta: true, key: 'i' })
  })

  it('派发器冒泡半开头那句 `defaultPrevented` 就是裁决本身(源码级守卫)', () => {
    /*
     * 「局部先接」不靠任何调度器:viewer / files 的局部监听仍挂在各自面域根上
     * (先于 window 的冒泡半收到),接住了就 preventDefault。这一句是它在全局
     * 那一侧的另一半。删掉它 → 改绑到 ⌘I 的那条全局命令会与行内键**同时**响,
     * 而那正是 F1 记下的那条留账。
     *
     * 09-02 R1 起这一句搬了家:唯一的派发器在 `focus/dispatch.ts`,`keymap/` 只
     * 剩那张动作表(`useKeymapCommandRunner`)。守卫跟着搬,判据一个字没变 ——
     * 它守的是「全局那一侧要让位」,不是「它长在哪只文件里」。
     */
    const source = readFileSync(path.join(srcRoot, 'focus/dispatch.ts'), 'utf-8')
    expect(source).toMatch(/if \(e\.defaultPrevented\) return/)
  })
})
