import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Tabs } from '../Tabs'
import type { TabSpec } from '../Tabs'

/**
 * **预览格那一档**(C2,正本
 * `apps/desktop-react/docs/session-continuity-2026-09.md` §4 + 拍点 5)。
 *
 * 拍点 5 定的是「斜体标题,与 VS Code 同一约定;不用计数徽、不换底色」,而这两件
 * 在 jsdom 里各有各的量法:
 *   · **档**是 DOM 上一格属性(`data-tab-preview`)—— jsdom 里是事实,直接断言;
 *   · **斜体**是 CSS Module 里那条规则 —— jsdom 不排版,所以照 `select-width-css`
 *     那一族的先例**读样式表源文本**(读之前先剥注释:病历文本会让断言自红,
 *     CLAUDE.md 那条);
 *   · **状态词**是一句只念不看的话,它进这一格 tab 的可访问名 —— 用可访问名查得到
 *     才算数(斜体读屏软件看不见,这一条正是那件事的补丁)。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const cssText = (): string =>
  readFileSync(path.join(here, '..', 'Tabs.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const ITEMS: TabSpec[] = [
  { id: 'a', label: 'alpha' },
  { id: 'b', label: 'beta', preview: '预览' },
]

function renderTabs(items: TabSpec[] = ITEMS) {
  return render(<Tabs items={items} activeId="a" look="joined" onSelect={() => {}} label="tabs" />)
}

describe('预览格', () => {
  it('只有预览那一格带 `data-tab-preview`,别的一格 DOM 都没变', () => {
    renderTabs()
    const [plain, preview] = screen.getAllByRole('tab')
    expect(plain.hasAttribute('data-tab-preview')).toBe(false)
    expect(preview.hasAttribute('data-tab-preview')).toBe(true)
  })

  it('标题**斜体**(拍点 5;不换底色、不加徽 —— 那条规则里只有 font-style)', () => {
    const css = cssText()
    const rule = /\.tab\[data-tab-preview\]\s+\.label\s*\{([^}]*)\}/.exec(css)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('font-style: italic')
    // 不换底色 / 不加徽:这条规则里除了字形什么都不许有。
    expect(rule![1]).not.toMatch(/background|content|--st-/)
  })

  it('状态词**只念不看**:进可访问名,而屏幕上那一段是 `.visually-hidden`', () => {
    renderTabs()
    // 读屏软件念得到「beta 预览」——斜体它看不见,所以这一句非有不可。
    const tab = screen.getByRole('tab', { name: /beta\s*预览/ })
    expect(tab.querySelector('.visually-hidden')?.textContent).toBe('预览')
  })

  /*
   * **反证**:把 `ui/Tabs.tsx` 里那句
   * `{tab.preview && <span className="visually-hidden">{tab.preview}</span>}`
   * 拆掉 → 上面这一条当场红(`data-tab-preview` 还在,可访问名里那个词没了)。
   * `scripts/gate-a11y.mjs` 会话总览那一屏量的是同一件事的真机那一半。
   */

  it('真机门那一屏**声明在册**(`gate:a11y` 会话总览那一屏)', () => {
    /*
     * 这条不跑门,它守的是**声明还在不在**:预览标签唯一的用户路是「在会话列表里
     * 点一行」,而那块面只在 `gate:a11y` 的会话总览那一屏被打开过 —— 断言挪走 /
     * 被顺手删掉的话,「斜体读屏软件看不见」这件事就没有真机那一半在守了。
     * 读脚本源文本是这台壳里既有的手法(同 `select-width-css` 读样式表)。
     */
    const gate = readFileSync(
      path.join(here, '..', '..', '..', 'scripts', 'gate-a11y.mjs'),
      'utf8',
    )
    expect(gate).toContain('[data-topbar-leaf] [data-tab-preview]')
    /*
     * 36f4df1c 起出厂档是 `replace`,那一屏量的是「零预览格」这条反面证据
     * (预览格只在用户自己切到 `preview` 档之后才产生),状态词那一句归 `preview`
     * 档、留账在门里。这里守的仍是「声明还在不在」,不是它此刻断言哪句话。
     */
    expect(gate).toContain('零预览格')
  })

  it('缺席就一件都不挂 —— 没有 `preview` 的条与从前逐字相同', () => {
    const before = render(
      <Tabs items={[{ id: 'a', label: 'alpha' }]} activeId="a" onSelect={() => {}} label="t" />,
    ).container.querySelector('[role="tablist"]')!.innerHTML
    const after = renderTabs([{ id: 'a', label: 'alpha', preview: undefined }])
      .container.querySelector('[role="tablist"]')!.innerHTML
    expect(after).toBe(before)
  })
})
