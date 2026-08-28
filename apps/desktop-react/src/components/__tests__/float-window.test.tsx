import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'

/**
 * 浮窗的挂载路径:形态机说「它是 float」,外壳就该画出一扇有标题、有三个控件的窗,
 * 而且内容与舞台/钉栏用的是同一张 renderContent 表。
 * 拖拽的算术在 transitions 的纯函数里测(那里能给定视口),这里只钉「画得出来、控件接得上」。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
})

/** store 在 React 事件之外被推动,所以得进 act —— 否则断言会读到上一帧。 */
function openFloat(id: string) {
  act(() => useStageStore.getState().openAs(id, { kind: 'float' }))
}

describe('浮窗层', () => {
  it('placements 里是 float 就画出一扇窗,标题是那块瓦的名字', () => {
    render(<AppShell />)
    openFloat('files')
    expect(screen.getByRole('dialog', { name: '文件' })).toBeTruthy()
  })

  it('叠序按 floatOrder 递增:后开的在上面', () => {
    render(<AppShell />)
    openFloat('files')
    openFloat('diff')
    const first = screen.getByRole('dialog', { name: '文件' }) as HTMLElement
    const second = screen.getByRole('dialog', { name: '改动' }) as HTMLElement
    expect(first.style.zIndex).toBe('calc(var(--z-float) + 0)')
    expect(second.style.zIndex).toBe('calc(var(--z-float) + 1)')
  })

  it('头上的「上舞台」把这一扇换成舞台', () => {
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '文件' })
    fireEvent.click(within(win).getByLabelText('上舞台'))
    expect(useStageStore.getState().placements.files).toEqual({ kind: 'stage' })
  })

  it('头上的「收回 Dock」把它收回去,矩形留着当记忆', () => {
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '文件' })
    fireEvent.click(within(win).getByLabelText('收回 Dock'))
    const st = useStageStore.getState()
    expect('files' in st.placements).toBe(false)
    expect(st.floatOrder).toEqual([])
    expect(st.floats.files).toBeTruthy()
  })
})
