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
    isPinned: false,
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
    active: false,
    showProject: true,
    // 行不再自己 `useT()`(冷开预算,见组件文件头病历第 ② 笔):`t` 由父层递进来。
    // 这里用的是 i18n 那只非 hook 的 `t` —— 它当场读 store,而上面刚把 locale 钉成 'zh'。
    t,
    onEnter: noop,
    onPeek: noop,
    onTogglePin: noop,
    onToggleRoom: noop,
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

  it('形态图标列**全行预留**:普通聊天那一格在场但是空的', () => {
    const { container } = renderRow({ kind: 'chat' })
    const glyph = container.querySelector('[aria-hidden="true"]')!
    expect(glyph).toBeTruthy()
    expect(glyph.childElementCount).toBe(0)
    expect(glyph.textContent).toBe('')
  })

  it('房间 / agent 私聊 / 派工 / 执行各画各的图标,人 ⇄ agent 私聊画首字', () => {
    for (const kind of ['room', 'swap', 'work', 'agent'] as SessionKind[]) {
      const { container, unmount } = renderRow({ kind })
      expect(container.querySelector('[aria-hidden="true"] svg')).toBeTruthy()
      unmount()
    }
    const { container } = renderRow({ kind: 'dm', title: '和 Ying 的私聊' })
    expect(container.querySelector('[aria-hidden="true"] svg')).toBeNull()
    expect(container.querySelector('[aria-hidden="true"]')!.textContent).toBe('和')
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

describe('悬停动作:常驻 DOM、只动 opacity、不进 Tab 序', () => {
  it('眼睛与图钉**永远在 DOM 里**(不是 hover 才插进来 —— 那会挤动整行)', () => {
    renderRow()
    expect(screen.getByTestId('session-row-peek-os-expose')).toBeTruthy()
    expect(screen.getByTestId('session-row-pin-os-expose')).toBeTruthy()
  })

  it('两颗都 tabIndex=-1:树只有一个 Tab 位,行上的动作不占位', () => {
    renderRow()
    expect(screen.getByTestId('session-row-peek-os-expose').tabIndex).toBe(-1)
    expect(screen.getByTestId('session-row-pin-os-expose').tabIndex).toBe(-1)
  })

  it('图钉的名字随状态换:未置顶说「置顶」,置顶了说「取消置顶」', () => {
    const { unmount } = renderRow()
    expect(screen.getByTestId('session-row-pin-os-expose').getAttribute('aria-label')).toBe('置顶')
    unmount()
    renderRow({ isPinned: true })
    const pin = screen.getByTestId('session-row-pin-os-expose')
    expect(pin.getAttribute('aria-label')).toBe('取消置顶')
    expect(pin.getAttribute('aria-pressed')).toBe('true')
  })

  it('点动作不顺带「进这条会话」—— 两条路各走各的', () => {
    const onEnter = vi.fn()
    const onPeek = vi.fn()
    const onTogglePin = vi.fn()
    renderRow({ onEnter, onPeek, onTogglePin })
    fireEvent.click(screen.getByTestId('session-row-peek-os-expose'))
    fireEvent.click(screen.getByTestId('session-row-pin-os-expose'))
    expect(onPeek).toHaveBeenCalledWith('os-expose')
    expect(onTogglePin).toHaveBeenCalledWith('os-expose')
    expect(onEnter).not.toHaveBeenCalled()
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
