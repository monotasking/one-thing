import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { t } from '../../i18n'
import type { SessionKind } from '../types'
import { SessionRow } from './SessionRow'

// 语言钉死:缺省是 'system'(问 navigator),而这一组里有几条按中文文案断言。
beforeEach(() => useStageStore.setState({ locale: 'zh' }))

/**
 * 一条会话行。这一组是**逐条钉形状**的:第一个 span 是完整标题、图标列全行预留、
 * 动作常驻只动 opacity、子行缩进、`aria-*` 四格。真机几何由 `gate:squeeze` 判,
 * 这里判的是结构与语义(jsdom 不排版)。
 */
const noop = () => undefined

function renderRow(over: Partial<React.ComponentProps<typeof SessionRow>> = {}) {
  const props: React.ComponentProps<typeof SessionRow> = {
    id: 'os-expose',
    title: '会话总览 Exposé 设计',
    kind: 'chat' as SessionKind,
    projectName: 'start-electron',
    time: '14:32',
    query: '',
    depth: 0,
    // 09-04:层级由模型给(节头占第 1 级,顶层会话从第 2 级起)——
    // 行不再拿 depth+1 现算,所以夹具要把它当一格真 prop 递进来。
    level: 2,
    expandable: false,
    expanded: false,
    current: false,
    // W5-b:三态标记。缺省「没开」= 与 W1 那版行的形逐字相同(不画那颗点)。
    openState: null,
    active: false,
    // 09-12:这一行的动作菜单开着没有(⋯ 的第三个显形判据)。
    menuOpen: false,
    // A2:这一行在原地改名没有(标题那一格换成输入框的那一档)。
    renaming: false,
    showProject: true,
    // 行不再自己 `useT()`(冷开预算,见组件文件头病历第 ② 笔):`t` 由父层递进来。
    // 这里用的是 i18n 那只非 hook 的 `t` —— 它当场读 store,而上面刚把 locale 钉成 'zh'。
    t,
    onEnter: noop,
    onToggleRoom: noop,
    onDragPointerDown: noop,
    onRestore: noop,
    onMenu: noop,
    onRenameCommit: noop,
    onRenameCancel: noop,
    ...over,
  }
  return { ...render(<SessionRow {...props} />), props }
}

const row = (id = 'os-expose') => screen.getByTestId(`session-row-${id}`)

describe('行的结构契约', () => {
  /**
   * **gate-data.mjs 按 `el.querySelector('span')` 读标题**(设计 §3.4)——
   * 所以行首那一列形态图标必须不是 `<span>`,而 `Highlight` 不许把标题 span 切碎。
   */
  it('`[data-session-id]` 里第一个 span 就是完整标题(图标列不是 span)', () => {
    renderRow()
    const el = document.querySelector('[data-session-id="os-expose"]')!
    expect(el.querySelector('span')?.textContent).toBe('会话总览 Exposé 设计')
  })

  it('搜到词也一样:高亮切片长在标题 span **里面**,不把它切成两个 span', () => {
    renderRow({ query: 'Exposé' })
    const el = document.querySelector('[data-session-id="os-expose"]')!
    const first = el.querySelector('span')!
    expect(first.textContent).toBe('会话总览 Exposé 设计')
    expect(first.querySelector('mark')?.textContent).toBe('Exposé')
  })

  /*
   * 09-12 **翻面**:从「全行预留」变成「只在有字形的行上画」(正本 §3.1)。
   * 病历:240px 的架子里那 16px 空列是标题净宽 83px 里的一笔实税,而屏幕上
   * 大多数行是普通聊天。代价(标题起笔线不再逐行对齐)是用户拍的。
   */
  it('形态字形**只在有字形的行上在场**:普通聊天连那一格都不画', () => {
    const { container } = renderRow({ kind: 'chat' })
    // 行里唯一的 aria-hidden 是行尾那颗 ⋯ 的图标,不是一格空的字形列。
    const glyphBox = container.querySelector('[data-session-id] > [aria-hidden="true"]')
    expect(glyphBox).toBeNull()
  })

  it('普通聊天行的**第一个元素子节点就是标题 span**(标题直接从左内缘起笔)', () => {
    renderRow({ kind: 'chat' })
    const el = document.querySelector('[data-session-id="os-expose"]')!
    expect(el.firstElementChild?.tagName).toBe('SPAN')
    expect(el.firstElementChild?.textContent).toBe('会话总览 Exposé 设计')
  })

  it('房间 / agent 私聊 / 派工 / 执行各画各的图标,人 ⇄ agent 私聊画首字', () => {
    // 字形那一格是行的**第一个**元素子节点(有它的时候),所以按位置取它 ——
    // 行尾那颗 ⋯ 的图标同样是 aria-hidden,不分位置就会取错。
    const glyphBox = () =>
      document.querySelector('[data-session-id] > [aria-hidden="true"]:first-child')
    for (const kind of ['room', 'swap', 'work', 'agent'] as SessionKind[]) {
      const { unmount } = renderRow({ kind })
      expect(glyphBox()?.querySelector('svg'), kind).toBeTruthy()
      unmount()
    }
    renderRow({ kind: 'dm', title: '和 Ying 的私聊' })
    expect(glyphBox()?.querySelector('svg')).toBeFalsy()
    expect(glyphBox()?.textContent).toBe('和')
  })

  it('子行缩进走 data-depth,别的一格不变(缩的是内边距,命中区仍铺满整行)', () => {
    renderRow({ depth: 1, level: 3 })
    expect(row().getAttribute('data-depth')).toBe('1')
    // 缩进(depth)与层级(level)是**两格**:前者是像素,后者是 aria。
    expect(row().getAttribute('aria-level')).toBe('3')
  })

  it('层级照模型给的画,不由 depth 现算 —— 两格解耦(反证:depth 0 + level 3)', () => {
    renderRow({ depth: 0, level: 3 })
    expect(row().getAttribute('aria-level')).toBe('3')
  })
})

describe('行的 aria 四格', () => {
  it('treeitem + level;当前会话报 aria-selected', () => {
    renderRow({ current: true })
    expect(row().getAttribute('role')).toBe('treeitem')
    // 第 1 级归节头(09-04 分组可折叠之后),顶层会话是第 2 级。
    expect(row().getAttribute('aria-level')).toBe('2')
    expect(row().getAttribute('aria-selected')).toBe('true')
    expect(row().id).toBe('expose-row-os-expose')
  })

  it('只有房间才有 aria-expanded —— 普通行不报一个假的「收起」', () => {
    const { unmount } = renderRow()
    expect(row().hasAttribute('aria-expanded')).toBe(false)
    unmount()
    renderRow({ kind: 'room', expandable: true, expanded: false })
    expect(row().getAttribute('aria-expanded')).toBe('false')
  })

  it('活动行只在 active 时挂 data-active(柔光环的唯一判据)', () => {
    const { unmount } = renderRow()
    expect(row().hasAttribute('data-active')).toBe(false)
    unmount()
    renderRow({ active: true })
    expect(row().getAttribute('data-active')).toBe('true')
  })
})

describe('悬停动作:一颗 ⋯、常驻 DOM、只动 opacity、不进 Tab 序', () => {
  const more = () => screen.getByTestId('session-row-menu-os-expose')

  /*
   * 09-12 拍板 3:悬停只出一颗 ⋯,与右键弹**同一张表**。眼睛与图钉退役 ——
   * 前者进菜单成「Quick Look」那一行(Space 那条键盘等价照旧),
   * 后者归 A2(此刻只有 ⌘⇧P 一条路,缺口记在 A1 的交卷报留账里)。
   */
  it('行上只有**一颗**动作钮,而且就是那颗 ⋯', () => {
    const { container } = renderRow()
    expect(more()).toBeTruthy()
    expect(container.querySelectorAll('[data-session-id] button').length).toBe(1)
    expect(screen.queryByTestId('session-row-peek-os-expose')).toBeNull()
    expect(screen.queryByTestId('session-row-pin-os-expose')).toBeNull()
  })

  it('它**永远在 DOM 里**(不是 hover 才插进来 —— 那会挤动整行),tabIndex=-1', () => {
    renderRow()
    expect(more().tabIndex).toBe(-1)
    expect(more().getAttribute('aria-label')).toBe('更多操作')
  })

  it('点它 = 弹那一行的动作表,**不顺带「进这条会话」**;锚是它自己的矩形', () => {
    const onEnter = vi.fn()
    const onMenu = vi.fn()
    renderRow({ onEnter, onMenu })
    fireEvent.click(more())
    expect(onMenu).toHaveBeenCalledTimes(1)
    expect(onMenu.mock.calls[0][0]).toBe('os-expose')
    // jsdom 的矩形恒零,所以这里只钉「递的是一个点」而不是具体坐标 ——
    // 真的落位由 gate:sessions ③ 在真机上量(`elementFromPoint`)。
    expect(onMenu.mock.calls[0][1]).toEqual({ x: 0, y: 0 })
    expect(onEnter).not.toHaveBeenCalled()
  })

  it('菜单开着时行上挂 data-menu-open(⋯ 的第三个显形判据)', () => {
    const { unmount } = renderRow()
    expect(row().hasAttribute('data-menu-open')).toBe(false)
    unmount()
    renderRow({ menuOpen: true })
    expect(row().getAttribute('data-menu-open')).toBe('true')
  })

  it('右键也走同一口,递的是光标坐标(点锚不跟滚)', () => {
    const onMenu = vi.fn()
    renderRow({ onMenu })
    fireEvent.contextMenu(row(), { clientX: 42, clientY: 84 })
    expect(onMenu).toHaveBeenCalledWith('os-expose', { x: 42, y: 84 })
  })

  it('点行本身 = 进这条会话,**回调带 id**(memo 的前提,见文件头病历)', () => {
    const onEnter = vi.fn()
    renderRow({ onEnter })
    fireEvent.click(row())
    expect(onEnter).toHaveBeenCalledWith('os-expose')
  })

  it('展开箭头只在房间行上,点它是 toggleRoom 而不是进会话', () => {
    const onEnter = vi.fn()
    const onToggleRoom = vi.fn()
    const { unmount } = renderRow({ onEnter, onToggleRoom })
    expect(screen.queryByTestId('session-row-caret-os-expose')).toBeNull()
    unmount()
    renderRow({ kind: 'room', expandable: true, onEnter, onToggleRoom })
    fireEvent.click(screen.getByTestId('session-row-caret-os-expose'))
    expect(onToggleRoom).toHaveBeenCalledWith('os-expose')
    expect(onEnter).not.toHaveBeenCalled()
  })
})

describe('项目名与时间', () => {
  /*
   * 两格都**只在总览形(容器 ≥ 761)看得见** —— 那是一条容器查询,jsdom 不跑
   * 排版也不跑容器查询,所以这一组问的仍然是「DOM 里有没有这一格」。
   * 「侧栏形里它们不在场」由 `Overview.test` 那条读 CSS 文本的用例钉
   * (`display: none` 在基准规则里),真的看不见由 gate:sessions ② / ⑥ 量。
   */
  it('只有「全部」范围显项目名(别的范围里它是句废话)', () => {
    const { unmount } = renderRow({ showProject: false })
    expect(screen.queryByText('start-electron')).toBeNull()
    unmount()
    renderRow({ showProject: true })
    expect(screen.getByText('start-electron')).toBeTruthy()
  })

  it('无项目的会话不画一格空 chip', () => {
    renderRow({ projectName: null })
    expect(row().textContent).toBe('会话总览 Exposé 设计14:32')
  })
})
