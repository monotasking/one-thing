import { readFileSync } from 'node:fs'
import path from 'node:path'
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

/**
 * **钉边钮的收编(09-02 批 8b)。** 从前它外面包着一格贴身 `span`
 *(`.actionSlot`)—— 存在的唯一理由是「`ui/IconButton` 递不进 ref,量不到钮
 * 自己的矩形」。批 8a 把那格类型补上,于是 ref 直接落在钮上,包裹退役。
 *
 * 两条断言各管一半,拆掉哪一半都真红:
 *  · 结构:钮的爹就是那条 `<header>`(包裹回来 → 爹变成 SPAN);
 *  · 行为:点一下**真的开出菜单** —— 菜单的坐标取自 `pinRef.current` 的矩形,
 *    ref 没接上时 `pinRef.current` 是 null,`if (r)` 落空,菜单永远不出。
 *    这一条同时把「键盘 ↵ 也走这条路」钉住:它走的是同一个 onClick,
 *    不是 onPointerDown 记一次(那条路按 ↵ 到不了,菜单会开在 0,0)。
 */
describe('浮窗檐:钉边钮直接消费 ui/IconButton 的 ref', () => {
  it('本地那格贴身包裹的皮肤已经删干净了', () => {
    // 判据只能读**源文本**:vitest 把 CSS Modules 换成了一只 proxy,
    // 任何键都返回一个像模像样的类名,所以 `floatCss.actionSlot` 永远不是
    // undefined —— 那条断言会陪跑。读源文本前先剥注释(病历里写着这个名字)。
    const css = readFileSync(path.resolve(__dirname, '../FloatWindow.module.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(css).not.toContain('.actionSlot')
  })

  it('钉边钮是檐的直接孩子,不再裹一层 span', () => {
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '文件' })
    const pin = within(win).getByLabelText('钉到边')
    expect(pin.parentElement?.tagName).toBe('HEADER')
  })

  it('点它开出钉边菜单 —— 坐标是从钮自己的 ref 上量的', () => {
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '文件' })
    fireEvent.click(within(win).getByLabelText('钉到边'))
    expect(screen.getByRole('menu', { name: '钉到边' })).toBeTruthy()
  })
})
