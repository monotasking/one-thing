import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { Overview } from './Overview'
import { GROUPS, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useExposeStore } from '../store'
import { initialExposeState } from '../transitions'

/**
 * 这一批是「折叠/展开原地形变」的回归闸(用户实机报的 bug:
 * 鼠标停在原地只能点一次,再点没反应)。真因是折叠态与展开态曾是**两个不同的
 * DOM 结构** —— 折叠行 .collapsedRow 是整行按钮,展开后组头换成另一套几何,
 * 指针底下那个点落到了不可点的 .groupPath 上。
 *
 * 所以这里断言的不是「点了会变」,而是「同一个节点连点 N 次 = 切换 N 次」:
 * 前者旧代码也过,后者只有原地形变才过。
 */
const FIRST_GROUP = GROUPS[0].id

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, view: { mode: 'overview' } })
})

const ids = () =>
  screen
    .getAllByTestId(/^group-toggle-/)
    .map((el) => el.getAttribute('data-testid'))

describe('总览组头:折叠/展开是原地形变', () => {
  it('鼠标不动连点四次 = 精确切换四次,且每次命中的是同一个 DOM 节点', () => {
    render(<Overview />)
    const toggle = screen.getByTestId(`group-toggle-${FIRST_GROUP}`)

    expect(useExposeStore.getState().collapsedGroups).not.toContain(FIRST_GROUP)
    for (const expected of [true, false, true, false]) {
      // 故意不重新查询:复用同一个引用,模拟「指针一动不动再点一次」
      fireEvent.click(toggle)
      expect(useExposeStore.getState().collapsedGroups.includes(FIRST_GROUP)).toBe(expected)
      expect(screen.getByTestId(`group-toggle-${FIRST_GROUP}`)).toBe(toggle)
    }
  })

  it('组头在两态里是同一个节点,aria-expanded 跟着翻,组头本身不被卸载', () => {
    render(<Overview />)
    const toggle = screen.getByTestId(`group-toggle-${FIRST_GROUP}`)
    expect(toggle).toHaveProperty('isConnected', true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(toggle.isConnected).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.isConnected).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('组的次序只由数据决定,手动折叠不重排', () => {
    render(<Overview />)
    const before = ids()
    fireEvent.click(screen.getByTestId(`group-toggle-${FIRST_GROUP}`))
    expect(ids()).toEqual(before)
    fireEvent.click(screen.getByTestId('group-toggle-collab'))
    expect(ids()).toEqual(before)
  })

  it('折叠只收起卡片区,组头那一行仍在(所以位置不跳)', () => {
    render(<Overview />)
    const toggle = screen.getByTestId(`group-toggle-${FIRST_GROUP}`)
    const headerBefore = toggle.parentElement
    fireEvent.click(toggle)
    expect(toggle.parentElement).toBe(headerBefore)
    expect(headerBefore?.isConnected).toBe(true)
  })
})

/**
 * D1 的新行为:**没有卡时不回退 mock**。三种「空」各说各的话 ——
 * 还在读 / 读不到(没连上 core)/ 真的一条会话都没有。
 */
describe('会话侧的三种空态', () => {
  it('读不到时说的是「没连上 core」,并带上那句错误原文', () => {
    seedSessionsSource({ status: 'error', error: '连不上', sessions: [] })
    render(<Overview />)
    expect(screen.getByText('没连上 core')).toBeTruthy()
    expect(screen.getByText(/连不上/)).toBeTruthy()
  })

  it('还在读时说的是「正在读会话」,不画一张假卡', () => {
    seedSessionsSource({ status: 'loading', sessions: [] })
    render(<Overview />)
    expect(screen.getByText('正在读会话…')).toBeTruthy()
    expect(screen.queryAllByTestId(/^group-toggle-/).length).toBe(0)
  })

  it('真的一条都没有时是「这里还没有会话」', () => {
    seedSessionsSource({ status: 'ready', sessions: [] })
    render(<Overview />)
    expect(screen.getByText('这里还没有会话')).toBeTruthy()
  })
})
