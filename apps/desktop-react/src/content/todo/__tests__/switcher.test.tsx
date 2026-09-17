import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { resetTodoSource, todoSearchFamily, type TodoNoteSummary } from '../../../data/todo-source'
import { focusTree } from '../../../focus/registry'
import { FocusDispatchHarness } from '../../../test/focus-harness'
import { useStageStore } from '../../../stage/store'
import { resetTodoPanelState, useTodoPanelState } from '../panel-state'
import { TODO_RECENT_LIMIT, useTodoPreferences } from '../preferences'
import { TODO_SEARCH_DEBOUNCE_MS, TodoSwitcher } from '../TodoSwitcher'

/**
 * 待办窗的切换 / 搜索弹层(B 形 U3,正本 `docs/todo-app-b-2026-09.md` §2.2)。
 *
 * 守:空词两组 + 新建;有字本地过滤清单、项组读 `todoSearchFamily` 那一格;↵ 落在键盘位上
 * (鼠标经过不改它);点一条项 = 记下「滚到哪一行」再打开那份清单;Esc 先清空再关。
 * 项组的数据直接 `patch` 进那一格 —— 这一层只关心「那个词的答案怎么画」,传输面不在场。
 */

const note = (id: string, title: string, total = 3, done = 1): TodoNoteSummary => ({
  ref: `todo:note/${id}`,
  id,
  title,
  updatedAt: 0,
  total,
  done,
})

const NOTES = [note('work', '工作'), note('shop', '购物'), note('trip', '旅行'), note('buy', '买书单')]

let opened: string[] = []
let created: string[] = []
let closed = 0

function mount() {
  return render(
    <>
      <FocusDispatchHarness />
      <TodoSwitcher
        anchor={() => new DOMRect(0, 0, 400, 36)}
        notes={NOTES}
        activeId="work"
        onClose={() => { closed += 1 }}
        onOpenList={id => opened.push(id)}
        onCreate={title => created.push(title)}
      />
    </>,
  )
}

const input = () => screen.getByTestId('todo-switcher-input') as HTMLInputElement
const options = () => screen.getAllByRole('option')

beforeEach(() => {
  vi.useFakeTimers()
  useStageStore.setState({ locale: 'zh' })
  useTodoPreferences.setState({ recent: ['trip', 'gone', 'work'], activeNoteId: 'work' })
  resetTodoPanelState()
  opened = []
  created = []
  closed = 0
})

afterEach(() => {
  vi.useRealTimers()
  resetTodoSource()
  focusTree.reset()
})

describe('切换 / 搜索弹层', () => {
  it('空词:「最近」按打开序(认不出的 id 跳过)+「全部清单」按名字排 + 新建', () => {
    mount()
    const groups = screen.getAllByRole('group')
    expect(groups[0].getAttribute('aria-label')).toBe('最近')
    expect(within(groups[0]).getAllByRole('option').map(o => o.dataset.testid)).toEqual([
      'todo-switcher-row-list-trip',
      'todo-switcher-row-list-work',
    ])
    expect(groups[1].getAttribute('aria-label')).toBe('全部清单')
    expect(within(groups[1]).getAllByRole('option')).toHaveLength(NOTES.length)
    expect(options().at(-1)?.textContent).toContain('新建清单')
    // 当前那一份标出来。
    expect(within(groups[0]).getAllByRole('option')[1].textContent).toContain('当前')
  })

  it('焦点一开就在输入框;↵ 落在键盘位上,鼠标经过不改它', () => {
    mount()
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.mouseEnter(options()[3])
    fireEvent.mouseMove(options()[3])
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(opened).toEqual(['work'])
  })

  it('有字:清单本地过滤当场出;项等停手后那一格的答案;没有同名就给「新建清单「x」」', () => {
    todoSearchFamily.get('书').patch({
      lists: [],
      items: [{ ref: 'todo:note/shop', id: 'shop', title: '购物', line: 4, text: '买一本书', done: false }],
      more: 0,
    })
    mount()
    fireEvent.change(input(), { target: { value: '书' } })
    expect(options().map(o => o.dataset.testid)).toEqual(['todo-switcher-row-list-buy', 'todo-switcher-row-create'])
    act(() => { vi.advanceTimersByTime(TODO_SEARCH_DEBOUNCE_MS) })
    expect(options().map(o => o.dataset.testid)).toEqual([
      'todo-switcher-row-list-buy',
      'todo-switcher-row-item-shop-4',
      'todo-switcher-row-create',
    ])
    expect(options().at(-1)?.textContent).toContain('新建清单「书」')
  })

  it('点一条项 = 记下那一行,再打开它所在的清单', () => {
    todoSearchFamily.get('书').patch({
      lists: [],
      items: [{ ref: 'todo:note/shop', id: 'shop', title: '购物', line: 4, text: '买一本书', done: true }],
      more: 3,
    })
    mount()
    fireEvent.change(input(), { target: { value: '书' } })
    act(() => { vi.advanceTimersByTime(TODO_SEARCH_DEBOUNCE_MS) })
    expect(screen.getByText(/还有 3 条/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('todo-switcher-row-item-shop-4'))
    expect(useTodoPanelState.getState().reveal).toMatchObject({ id: 'shop', line: 4 })
    expect(opened).toEqual(['shop'])
  })

  it('什么都没命中:一句「没有找到」+ 新建那一行,↵ 就建', () => {
    todoSearchFamily.get('zzz').patch({ lists: [], items: [], more: 0 })
    mount()
    fireEvent.change(input(), { target: { value: 'zzz' } })
    act(() => { vi.advanceTimersByTime(TODO_SEARCH_DEBOUNCE_MS) })
    expect(screen.getByText('没有找到「zzz」')).toBeTruthy()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(created).toEqual(['zzz'])
  })

  it('Esc 先清空输入,再按一次才关', () => {
    mount()
    fireEvent.change(input(), { target: { value: '工' } })
    act(() => void fireEvent.keyDown(input(), { key: 'Escape' }))
    expect(input().value).toBe('')
    expect(closed).toBe(0)
    act(() => void fireEvent.keyDown(input(), { key: 'Escape' }))
    expect(closed).toBe(1)
  })
})

describe('最近打开', () => {
  it('新的在前、去重、封顶;改名跟过去,删除摘掉', () => {
    useTodoPreferences.setState({ recent: [], activeNoteId: null })
    const { setActiveNoteId, replaceNoteId } = useTodoPreferences.getState()
    for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) setActiveNoteId(id)
    expect(useTodoPreferences.getState().recent).toEqual(['f', 'e', 'd', 'a', 'c'].slice(0, TODO_RECENT_LIMIT))
    replaceNoteId('f', 'f2')
    expect(useTodoPreferences.getState()).toMatchObject({ activeNoteId: 'f2', recent: ['f2', 'e', 'd', 'a', 'c'] })
    replaceNoteId('d', null)
    expect(useTodoPreferences.getState().recent).toEqual(['f2', 'e', 'a', 'c'])
  })
})
