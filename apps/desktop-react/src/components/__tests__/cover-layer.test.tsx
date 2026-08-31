import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CoverLayer } from '../CoverLayer'
import { useStageStore } from '../../stage/store'
import { initialStageState, initialStageSettings } from '../../stage/transitions'
import { APPS_ITEM_ID } from '../../stage/items'

/**
 * 盖(第三种形态)的宿主半边。形态机那一半在 stage/transitions.test.ts。
 *
 * 这里钉的是它**与舞台不同**的那几条:没有盖时一个节点都不画、点在盖自己的底上
 * 才关(点在内容里不关 —— 这块面里每一行都有一枚开关,「真·任意处关闭」会让它没法用)、
 * 以及头上那颗 ✕。
 */

beforeEach(() => {
  useStageStore.setState({ ...initialStageState, ...initialStageSettings, locale: 'zh' })
})

const formOf = (id: string) => useStageStore.getState().placements[id]?.kind ?? 'dock'
const openCover = () => act(() => useStageStore.getState().openAs(APPS_ITEM_ID, { kind: 'cover' }))

describe('盖', () => {
  it('没有盖时什么都不画', () => {
    const { container } = render(<CoverLayer />)
    expect(container.firstChild).toBeNull()
  })

  it('开了就画一块 role=dialog,名字是那块面的名字', () => {
    render(<CoverLayer />)
    openCover()
    expect(screen.getByRole('dialog', { name: '所有应用' })).toBeTruthy()
  })

  it('点在盖自己的底上 = 关', () => {
    const { container } = render(<CoverLayer />)
    openCover()
    act(() => void fireEvent.mouseDown(container.firstChild as Element))
    expect(formOf(APPS_ITEM_ID)).toBe('dock')
  })

  it('点在内容里**不关** —— 这块面里的开关得按得动', () => {
    render(<CoverLayer />)
    openCover()
    act(() => void fireEvent.mouseDown(screen.getByRole('dialog')))
    expect(formOf(APPS_ITEM_ID)).toBe('cover')
  })

  it('头上那颗 ✕ 关得掉(鼠标的第三条出口,前两条是点底与 Esc)', () => {
    render(<CoverLayer />)
    openCover()
    act(() => void screen.getByRole('button', { name: '关闭' }).click())
    expect(formOf(APPS_ITEM_ID)).toBe('dock')
  })
})
