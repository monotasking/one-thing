import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { NOW, SESSIONS, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useExposeStore } from '../store'
import { initialExposeState } from '../transitions'
import { ExposeView } from './ExposeView'

/**
 * 侧栏(Rail)—— 范围的唯一选择面。这一组钉的是设计 §1.3 / §3.1 的五件事:
 * 一个 Tab 位、roving 走位、`aria-selected`、`collab` / `loose` 非空才出、
 * **不带数字**。
 */
beforeEach(() => {
  // 真店的「现在」与夹具的 NOW 差着好几天,落桶会全塌进月桶 —— 钉住时间。
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  useStageStore.setState({ locale: 'zh', placements: {} })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, view: { mode: 'overview' } })
})

afterEach(() => vi.restoreAllMocks())

const rail = () => screen.getByTestId('expose-rail')
const options = () => [...rail().querySelectorAll<HTMLElement>('[role="option"]')]

describe('侧栏是一张读表画出来的范围表', () => {
  it('固定三档按 SCOPE_SPECS 的次序出场,项目跟在分隔线后面', () => {
    render(<ExposeView />)
    const ids = options().map((el) => el.getAttribute('data-testid'))
    expect(ids.slice(0, 3)).toEqual([
      'expose-scope-all',
      'expose-scope-collab',
      'expose-scope-loose',
    ])
    // 项目按「组内最新活动倒序」:onething 的最新一条是 8 分钟前,transreader 是 2 天前。
    expect(ids.slice(3)).toEqual([
      'expose-scope-project:/Users/dev/code/start-electron',
      'expose-scope-project:/Users/dev/code/transreader',
    ])
    expect(rail().querySelectorAll('[role="presentation"]').length).toBe(1)
  })

  it('collab / loose 只在非空时出现 —— 一条协作都没有就不摆那一格', () => {
    seedSessionsSource({ sessions: SESSIONS.filter((s) => s.kind === 'chat' && s.projectId) })
    render(<ExposeView />)
    const ids = options().map((el) => el.getAttribute('data-testid'))
    expect(ids).toContain('expose-scope-all')
    expect(ids).not.toContain('expose-scope-collab')
    expect(ids).not.toContain('expose-scope-loose')
  })

  it('**侧栏项不带数字**(08-30 计数禁令):每一项的文字就是它的名字,一个字不多', () => {
    render(<ExposeView />)
    const texts = options().map((el) => el.textContent)
    expect(texts.slice(0, 3)).toEqual(['全部', '协作', '无项目'])
    expect(texts.slice(3)).toEqual(['start-electron', 'transreader'])
  })

  it('点一项 = 换范围,选中那一项报 aria-selected', () => {
    render(<ExposeView />)
    fireEvent.click(screen.getByTestId('expose-scope-collab'))
    expect(useExposeStore.getState().scope).toEqual({ kind: 'collab' })
    const selected = options().filter((el) => el.getAttribute('aria-selected') === 'true')
    expect(selected.map((el) => el.getAttribute('data-testid'))).toEqual(['expose-scope-collab'])
  })
})

describe('侧栏的无障碍:一个 Tab 位 + roving', () => {
  it('listbox 有名字,项是 option', () => {
    render(<ExposeView />)
    expect(rail().getAttribute('role')).toBe('listbox')
    expect(rail().getAttribute('aria-label')).toBe('项目')
    expect(options().length).toBeGreaterThan(1)
  })

  it('**一个 Tab 位**:选中那一项 tabIndex=0,其余全是 -1', () => {
    render(<ExposeView />)
    const zero = options().filter((el) => el.tabIndex === 0)
    expect(zero.length).toBe(1)
    expect(zero[0].getAttribute('data-testid')).toBe('expose-scope-all')
  })

  it('↓ 由 roving 走位(焦点真的落在项上),树的活动行一格不动', () => {
    render(<ExposeView />)
    const before = useExposeStore.getState().focusId
    const items = options()
    act(() => items[0].focus())
    fireEvent.keyDown(rail(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    /*
     * 反证点:这一条同时钉住 ExposeView 那句 `if (e.defaultPrevented) return`。
     * 摘掉它,侧栏里按一下 ↓ 会**同时**把树的活动行也挪一格(一下键两处响)。
     */
    expect(useExposeStore.getState().focusId).toBe(before)
  })
})
