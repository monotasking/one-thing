import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import {
  NOW,
  SESSIONS,
  seedSessionsFailure,
  seedSessionsSource,
} from '../../data/__fixtures__/sessions'
import { useExposeStore } from '../store'
import { initialExposeState } from '../transitions'
import { ExposeView } from './ExposeView'

/**
 * 总览的**装配**:三块面在不在场、四种空态、错误与列表并存、搜索是过滤器。
 * 侧栏 / 工具栏 / 树各自的行为在它们自己那三份用例里。
 */
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  useStageStore.setState({ locale: 'zh', placements: {} })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, view: { mode: 'overview' } })
})

afterEach(() => vi.restoreAllMocks())

/**
 * 屏幕上的**会话行**。按 `[data-session-id]` 取而不是 `[role="treeitem"]`:
 * 09-04 分节可折叠之后节头也是 treeitem(它没有这一格),而这一组问的一直是
 * 「哪几条会话在屏幕上」。
 */
const rowIds = () =>
  [...document.querySelectorAll('[data-session-id]')].map((el) =>
    el.getAttribute('data-session-id'),
  )

/**
 * 打一个词进搜索框。09-12 起搜索是**三行导航里的一行** —— 顶上没有常驻输入框,
 * 所以要先点开那一行,输入框才存在(这一步就是用户真走的那一下)。
 */
const type = (value: string) => {
  const row = screen.queryByTestId('expose-search-row')
  if (row) fireEvent.click(row)
  fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value } })
}

describe('三块面的装配', () => {
  it('侧栏 / 三行导航 / 树同屏,滚动容器的 testid 留在原地(工作区门按它问)', () => {
    render(<ExposeView />)
    expect(screen.getByTestId('expose-rail')).toBeTruthy()
    expect(screen.getByTestId('expose-nav')).toBeTruthy()
    expect(screen.getByTestId('expose-tree')).toBeTruthy()
    expect(screen.getByTestId('expose-overview-scroll')).toBeTruthy()
  })

  /**
   * 宽度三档只看**容器宽**(container-name: expose 在 ExposeView.module.css)。
   * jsdom 不排版也不跑容器查询,所以这里钉的是**规则本身**(读源码,与卡片时代
   * 那两组几何用例同一个办法);真的有没有挤到,由 `npm run gate:squeeze` 判。
   */
  /**
   * **一档阈值,两种形**(09-12 方向 A,正本 §3)。480 那一档退役:它从前管的
   * 三件(项目签降元素 / 新会话缩图标钮 / 工具栏换行)前两件由侧栏形一并管掉,
   * 第三件随那只常驻搜索框一起没了。
   * 这里钉的仍然是**规则本身**(jsdom 不跑容器查询);真的有没有挤到、
   * 有没有在场,由 `npm run gate:sessions` 与 `gate:squeeze` 判。
   */
  it('一档阈值两种形:≤760 收侧栏、出范围行、行去掉时间与项目签', () => {
    const css = (name: string) =>
      readFileSync(resolve(__dirname, name), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css('Rail.module.css')).toMatch(/@container expose \(max-width: 760px\)[\s\S]*display: none/)
    // 范围行:> 阈值就不必画(侧栏已经是范围控件,顶上不出第二个)。
    expect(css('NavRows.module.css')).toMatch(
      /@container expose \(min-width: 761px\)[\s\S]*\.scopeRow[\s\S]*display: none/,
    )
    // 时间列与项目签:**基准规则里就不在场**,宽档那一组才把它们放回来。
    const row = css('SessionRow.module.css')
    expect(row).toMatch(/\.project \{\s*display: none/)
    expect(row).toMatch(/\.time \{\s*display: none/)
    expect(row).toMatch(
      /@container expose \(min-width: 761px\)[\s\S]*\.project \{\s*display: block/,
    )
    // 480 那一档一条都不许再有(留着一条恒真的空规则只会让下一个人以为还有一档)。
    for (const name of ['NavRows.module.css', 'SessionRow.module.css', 'SessionTree.module.css', 'Overview.module.css']) {
      expect(css(name), name).not.toMatch(/@container expose \(max-width: 480px\)/)
    }
  })

  it('行高与图标列走 token,不写字面量(Token 纪律)', () => {
    const css = readFileSync(resolve(__dirname, 'SessionRow.module.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    // 两种形各自那一格行高,以及「占位尺寸 = 这一档的真行高」那条对账。
    expect(css).toMatch(/height: var\(--expose-row-h\)/)
    expect(css).toMatch(/contain-intrinsic-size: auto var\(--expose-row-h\)/)
    expect(css).toMatch(/height: var\(--list-row-h\)/)
    expect(css).toMatch(/contain-intrinsic-size: auto var\(--list-row-h\)/)
    expect(css).toMatch(/width: var\(--expose-row-glyph\)/)
    expect(css).toMatch(/width: var\(--expose-glyph-w\)/)
    expect(css).toMatch(/var\(--expose-indent\)/)
    expect(css).toMatch(/width: var\(--expose-time-w\)/)
    /*
     * 组件文件里零字面色值 / px / ms。**容器查询那一行除外** —— `@container`
     * 的条件里不能写 var(),阈值只能是字面量(名字在 tokens.css,两处互相点名)。
     */
    const rules = css.replace(/@container[^{]*\{/g, '{')
    expect(rules).not.toMatch(/:\s*#[0-9a-f]{3,8}\b/i)
    expect(rules).not.toMatch(/:\s*\d+px/)
  })
})

describe('会话侧的四种空态', () => {
  it('读不到时说的是「没连上 core」,并带上那句错误原文', async () => {
    await seedSessionsFailure('连不上')
    render(<ExposeView />)
    expect(screen.getByText('没连上 core')).toBeTruthy()
    expect(screen.getByText(/连不上/)).toBeTruthy()
  })

  it('还在读时说的是「正在读会话」,不画一张假行', () => {
    seedSessionsSource({ sessions: [], phase: 'initial' })
    render(<ExposeView />)
    expect(screen.getByText('正在读会话…')).toBeTruthy()
    expect(rowIds()).toEqual([])
  })

  it('真的一条都没有时是「这里还没有会话」', () => {
    seedSessionsSource({ sessions: [] })
    render(<ExposeView />)
    expect(screen.getByText('这里还没有会话')).toBeTruthy()
    expect(screen.queryByText('正在读会话…')).toBeNull()
  })

  it('搜不到时是一行灰字,不是「这里还没有会话」也不是插画', () => {
    render(<ExposeView />)
    type('这个词哪儿都没有')
    expect(screen.getByText('没有匹配的会话')).toBeTruthy()
    expect(screen.queryByText('这里还没有会话')).toBeNull()
    expect(rowIds()).toEqual([])
  })
})

describe('错误与列表并存(律②的另一半)', () => {
  it('手上有列表时:行还在屏上,同时多出那一行原话', async () => {
    await seedSessionsFailure('core 掉了', SESSIONS)
    render(<ExposeView />)
    expect(rowIds().length).toBeGreaterThan(0)
    const line = screen.getByRole('status')
    expect(line.textContent).toContain('没连上 core')
    expect(line.textContent).toContain('core 掉了')
  })

  it('搜不到词的那一屏照样说 —— 手上有列表这件事不因为过滤而改变', async () => {
    await seedSessionsFailure('core 掉了', SESSIONS)
    render(<ExposeView />)
    type('哪儿都没有')
    expect(screen.getByRole('status').textContent).toContain('core 掉了')
  })

  it('没有错误时那一行不在场(零常驻像素)', () => {
    render(<ExposeView />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

/**
 * ── 搜索是过滤器,不是第四种形态 ────────────────────────────────────────────
 * 输入词之后屏幕仍是这一套(侧栏 + 工具栏 + 树,同样的 testid),只是内容少了。
 */
describe('总览搜索:过滤器,不是第四种形态', () => {
  it('搜索时三块面的 testid 一个没换', () => {
    render(<ExposeView />)
    type('Exposé')
    expect(screen.getByTestId('expose-rail')).toBeTruthy()
    expect(screen.getByTestId('expose-nav')).toBeTruthy()
    expect(screen.getByTestId('expose-tree')).toBeTruthy()
    expect(screen.getByTestId('session-row-os-expose')).toBeTruthy()
    // 行尾那颗 ⋯ 还在 —— 搜索结果照常有那张动作表(Quick Look 在它里面)。
    expect(screen.getByTestId('session-row-menu-os-expose')).toBeTruthy()
  })

  it('不命中的行消失,变空的节整个消失', () => {
    render(<ExposeView />)
    type('Exposé')
    expect(rowIds()).toEqual(['os-expose'])
    // 节头 09-04 从 `<h3>` 变成 `role="treeitem"` 的一格(它现在可折叠);
    // 「变空的节整个消失」因此按节头的 testid 数。
    expect(document.querySelectorAll('[data-section-id]').length).toBe(1)
  })

  it('命中词在行上高亮', () => {
    render(<ExposeView />)
    type('Exposé')
    expect([...document.querySelectorAll('mark')].map((m) => m.textContent)).toContain('Exposé')
  })

  it('子行命中 → 父房间**自动展开**(派生态,不落库)', () => {
    render(<ExposeView />)
    type('验收单')
    expect(rowIds()).toEqual(['rm-release', 'wk-verify'])
    expect(screen.getByTestId('session-row-rm-release').getAttribute('aria-expanded')).toBe('true')
    // 派生态:清了词就回到收起,`expandedRooms` 一格没写。
    expect(useExposeStore.getState().expandedRooms).toEqual([])
    type('')
    expect(rowIds()).not.toContain('wk-verify')
  })

  it('清空搜索词就回到全量,一格没变', () => {
    render(<ExposeView />)
    const before = rowIds()
    type('Exposé')
    type('')
    expect(rowIds()).toEqual(before)
  })
})

describe('范围是筛选器:换一档,树跟着换', () => {
  it('点「协作」→ 只剩房间 / 私聊那一族(子行归它们的父)', () => {
    render(<ExposeView />)
    fireEvent.click(screen.getByTestId('expose-scope-collab'))
    expect(rowIds()).toEqual(['rm-release', 'sw-pair', 'dm-ying'])
  })

  it('点项目 → 只剩那个目录下的会话,且**项目名不再出现在行上**(这一列是废话)', () => {
    render(<ExposeView />)
    expect(screen.getAllByText('start-electron').length).toBeGreaterThan(1)
    fireEvent.click(screen.getByTestId('expose-scope-project:/Users/dev/code/transreader'))
    expect(rowIds()).toEqual(['tr-menubar', 'tr-flask'])
    // 侧栏 / 选择器仍叫 transreader,但**行上**没有项目名了。
    expect(
      [...document.querySelectorAll('[data-session-id]')].map((el) => el.textContent),
    ).toEqual(['菜单栏翻译窗周四', 'Flask 端口冲突8月9日'])
  })
})
