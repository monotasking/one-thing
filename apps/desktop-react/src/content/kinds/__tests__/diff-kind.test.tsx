import { describe, expect, it } from 'vitest'
import { companionSeedOf, contentKindOf, focusIntoScopeOf, isSingletonContent } from '../../../workbench/kinds'
import { DIFF_KIND, diffRef, diffWorkdirOf } from '../diff-ref'
import '../index'

/**
 * **`diff` 那一种内容的自述**(正本
 * `apps/desktop-react/docs/changes-panel-2026-09.md` §3.1;壳侧 §4 第一组)。
 *
 * 这一组只问「表上那几格写的是什么」—— 面板长什么样归 `changes-panel.test.tsx`。
 * 四格 + seed 两档:
 *  ① 登记进了表(`contentKindOf` 认得它);
 *  ② **不是单例**(同一个目录可以在两片叶里各开一份);
 *  ③ 标题 = 目录名,tip = 全路径;
 *  ④ 激活它 = 焦点进 `diff` 那格作用域;
 *  ⑤ `companion.seed`:有 workdir → `diff:<workdir>`;没有 → `null`(**什么都不开**)。
 *
 * **反证**:`companion.seed` 改成恒 `null` → 下面第 ⑤ 条与
 * `content/__tests__/session-companions.test.ts` 那一条一起红。
 */

const ROOT = '/Users/dev/code/start-electron'

describe('`diff` 那一种内容的自述', () => {
  it('① 它在表上', () => {
    expect(contentKindOf(DIFF_KIND)).toBeDefined()
  })

  it('② **不是单例** —— 同一个目录可以在两片叶里各开一份', () => {
    expect(isSingletonContent(diffRef(ROOT))).toBe(false)
  })

  it('③ 标题 = 目录名,tip = 全路径(与目录 tab 同名,靠图标分辨)', () => {
    const title = contentKindOf(DIFF_KIND)!.title(diffRef(ROOT))
    expect(title.text).toBe('start-electron')
    expect(title.tip).toBe(ROOT)
  })

  it('③ 图标 = GitCompare(与 Dock 上那块瓦同一枚 —— 瓦与它开出来的内容同形)', () => {
    expect(contentKindOf(DIFF_KIND)!.icon(diffRef(ROOT))).toBe('GitCompare')
  })

  it('④ 激活它 = 焦点进 `diff` 那格作用域', () => {
    expect(focusIntoScopeOf(diffRef(ROOT))).toBe('diff')
  })

  it('⑤ seed:有 workdir → 那个目录的改动面', () => {
    expect(companionSeedOf(DIFF_KIND, { sessionId: 's1', workdir: ROOT })).toEqual(diffRef(ROOT))
  })

  it('⑤ seed:**没有 workdir → null**(不退到 `~` —— 主目录多半不是仓库)', () => {
    expect(companionSeedOf(DIFF_KIND, { sessionId: 's1', workdir: null })).toBeNull()
  })
})

describe('`diff-ref` 那三行', () => {
  it('造与反问是互逆的', () => {
    expect(diffWorkdirOf(diffRef(ROOT))).toBe(ROOT)
  })

  it('别的种类答 null(它是一句「这一格装的是不是改动面」)', () => {
    expect(diffWorkdirOf({ kind: 'dir', key: ROOT })).toBeNull()
  })
})
