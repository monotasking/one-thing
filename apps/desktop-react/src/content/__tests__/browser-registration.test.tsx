import { describe, expect, it } from 'vitest'
import '../kinds/browser'
import '../browser-launcher'
import { contentKindOf, focusIntoScopeOf, isSingletonContent, residencyLevelOf } from '../../workbench/kinds'
import { findItem } from '../../stage/items'
import { stageLauncherOf } from '../../stage/launchers'
import { BROWSER_KIND, browserRef } from '../browser/browser-ref'
import { BROWSER_ITEM_ID } from '../browser-launcher'
import { effectLabel } from '../permission/effect-label'
import { zh } from '../../i18n/zh'
import { en } from '../../i18n/en'

/**
 * **登记那两行的守卫**(B2)。
 *
 * 「加一种内容 = 它自己的模块 + 一行 import」那句话只有在这一组绿着的时候才是真的:
 * 种类表认得 `browser`、那块瓦是**启动瓦**而不是一块面、许可卡认得新那一档效果。
 */

describe('内容种类', () => {
  it('`browser` 在表里,而且那几格自述逐格对上', () => {
    const kind = contentKindOf(BROWSER_KIND)
    expect(kind).toBeTruthy()
    // 一格 tab 背后是**一片**原生视图,而一片视图只能在一个矩形里。
    expect(isSingletonContent(browserRef('t1'))).toBe(true)
    // 一格网页与「你此刻在做哪个项目」无关 —— 切工作区不该让它消失。
    expect(residencyLevelOf(browserRef('t1'))).toBe('app')
    // 开一格浏览器第一件想做的事就是打地址(响应链规则 2)。
    expect(focusIntoScopeOf(browserRef('t1'))).toBe('browser')
    expect(kind?.fullable).toBe(true)
    expect(kind?.icon(browserRef('t1'))).toBe('Globe')
    // **关标签 = 关这格 tab**,落点是 `dispose` 不是 `beforeClose`(没有要问的)。
    expect(typeof kind?.dispose).toBe('function')
    expect(kind?.beforeClose).toBeUndefined()
  })

  it('读数还没到时标题是字典里那句静态的(活的到了会盖上去)', () => {
    // 测试环境的语言是 en(与别的种类那几条用例同口径);两本字典的那一句
    // 由 `focus/__tests__/scopes.test.ts` 的成对检查钉着。
    expect(contentKindOf(BROWSER_KIND)?.title(browserRef('t1')).text).toBe(en['item.browser'])
  })
})

describe('Dock 那块瓦', () => {
  it('降格成**启动瓦**:三口都在,而且 `level` 是 app', () => {
    const launcher = stageLauncherOf(BROWSER_ITEM_ID)
    expect(launcher).toBeTruthy()
    expect(typeof launcher?.open).toBe('function')
    expect(typeof launcher?.dragRef).toBe('function')
    expect(launcher?.residentKind).toBe(BROWSER_KIND)
    expect(launcher?.MenuRows).toBeTruthy()
    expect(findItem(BROWSER_ITEM_ID)?.level).toBe('app')
    /*
     * **天生落中央区 = 缺席**(判词在 `stage/items.ts` 那一行上):`OpenPlacement`
     * 里没有「中央」这一档,中央是启动瓦问完记忆与天生之后的兜底。
     */
    expect(findItem(BROWSER_ITEM_ID)?.defaultPlacement).toBeUndefined()
  })
})

describe('许可卡', () => {
  it('认得 `browser_navigate` 这一档,而且两本字典成对', () => {
    expect(zh['permission.effect.browser_navigate']).toBeTruthy()
    expect(en['permission.effect.browser_navigate']).toBeTruthy()
    const t = ((key: string) => zh[key as keyof typeof zh]) as never
    expect(effectLabel(t, 'browser_navigate')).toBe(zh['permission.effect.browser_navigate'])
  })

  it('认不出来的效果类**原样显示那个英文枚举**(编一句中文是猜)', () => {
    const t = ((key: string) => zh[key as keyof typeof zh]) as never
    expect(effectLabel(t, 'not_a_real_effect')).toBe('not_a_real_effect')
  })
})
