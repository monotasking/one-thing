import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { useWorkbenchStore } from '../../workbench/store'
import { refId } from '../../workbench/kinds'
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

/**
 * **开这扇窗的叶菜单**(W7-c 裁定 4)。檐上只剩 ✕ 之后,「钉到边 ▸」与「上舞台」
 * 住在这张表里,而这扇窗的标题栏**就是**它根叶那条檐 —— 右键那条檐上的空白处
 * 就是设计说的「浮窗标题栏右键菜单」。
 *
 * 右键落在标签条**外面**那一段(动作组那一格)才算空白:落在一格标签上会被标签
 * 自己接走(那也开同一张表,只是贴着标签开)。这里取的是檐本身。
 */
function openLeafMenu(win: HTMLElement) {
  const chrome = win.querySelector('[data-pane-chrome]') as HTMLElement
  act(() => {
    fireEvent.contextMenu(chrome, { clientX: 10, clientY: 10 })
  })
  return screen.getByRole('menu', { name: '标签动作' })
}

describe('浮窗层', () => {
  it('placements 里是 float 就画出一扇窗,标题是那块瓦的名字', () => {
    render(<AppShell />)
    openFloat('files')
    expect(screen.getByRole('dialog', { name: '目录' })).toBeTruthy()
  })

  it('叠序按 floatOrder 递增:后开的在上面', () => {
    render(<AppShell />)
    openFloat('files')
    openFloat('diff')
    const first = screen.getByRole('dialog', { name: '目录' }) as HTMLElement
    const second = screen.getByRole('dialog', { name: '改动' }) as HTMLElement
    expect(first.style.zIndex).toBe('calc(var(--z-float) + 0)')
    expect(second.style.zIndex).toBe('calc(var(--z-float) + 1)')
  })

  it('叶菜单里的「上舞台」把这一扇换成舞台(W7-c:它从檐上的钮搬进了这张表)', () => {
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '目录' })
    const menu = openLeafMenu(win)
    act(() => {
      fireEvent.click(within(menu).getByText('上舞台'))
    })
    expect(useStageStore.getState().placements.files).toEqual({ kind: 'stage' })
  })

  /**
   * **W4 改判:那颗 ✕ 关的是「这扇窗」,里面的标签转为隐藏,不是关闭**
   * (设计 §2.2:「窗子没了,内容还在 hidden 里」)。
   *
   * 为什么不能仍旧叫「收回 Dock」:一扇窗里从 W4 起可能装着**文件**,而文件没有
   * Dock 可回 —— 「收回 Dock」这句话只对瓦说得通。隐藏对两者都说得通,而且它
   * 与「收回 Dock 不丢状态」是同一条判据(实例留着)。
   *
   * 反证:把 `closeFloat` 换回 `closeToDock` → 最后那两句红(那一份不进隐藏表,
   * 「隐藏的标签 ⋯」里点不回来)。
   */
  it('头上那颗 ✕ 关的是这扇窗:里面的标签转为隐藏,矩形留着当记忆', () => {
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '目录' })
    fireEvent.click(within(win).getByLabelText('关闭这扇窗'))
    const st = useStageStore.getState()
    expect('files' in st.placements).toBe(false)
    expect(st.floatOrder).toEqual([])
    expect(st.floats.files).toBeTruthy()
    // 隐藏 ≠ 关闭:那一格还在隐藏表里,记着它该回哪儿。
    const hidden = useWorkbenchStore.getState().hidden
    expect(hidden.map((entry) => refId(entry.ref))).toEqual(['panel:files'])
    expect(hidden[0].returnTo.region).toBe('float:files')
  })

  it('隐藏之后请得回来:同一份实例回到它原来那扇窗', () => {
    render(<AppShell />)
    openFloat('files')
    fireEvent.click(within(screen.getByRole('dialog', { name: '目录' })).getByLabelText('关闭这扇窗'))
    // 窗没了(屏幕上那一份是离场副本,`FloatLayer` 留它一帧播出场动画)。
    expect(useStageStore.getState().floatOrder).toEqual([])
    expect(screen.getByRole('dialog', { name: '目录' }).className).toContain('leaving')
    act(() => useWorkbenchStore.getState().restoreHidden('panel:files'))
    expect(useStageStore.getState().floatOrder).toEqual(['files'])
    expect(screen.getByRole('dialog', { name: '目录' }).className).not.toContain('leaving')
    expect(useWorkbenchStore.getState().hidden).toEqual([])
  })
})

/**
 * **檐上只剩 ✕**(W7-c 裁定 4;用户 09-05「按钮太多」)。
 *
 * W4 起这一组守的是「钉边钮直接消费 `ui/IconButton` 的 ref」——那颗钮没了,
 * 它守的那件事也跟着换了主人:钉边那张表不再贴着一颗钮开,它是**叶菜单里的一格
 * 子菜单**,而叶菜单开在右键那一点上。
 *
 * 三条断言各管一半,拆掉哪一半都真红:
 *  · 本地那格贴身包裹的皮肤仍旧不许回来(源文本判据,与从前逐字相同);
 *  · 檐上**恰好一颗钮**,而它是 ✕ —— 多一颗就是减法白做了;
 *  · 「钉到边 ▸」在叶菜单里,展开之后四条边全在,点一条真的钉过去
 *    (与从前那颗钮**同一只** `floatToEdge`)。
 */
describe('浮窗檐:只剩 ✕,钉边与上舞台进叶菜单', () => {
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

  it('檐右端只有一颗钮,而且是 ✕', () => {
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '目录' })
    const close = within(win).getByLabelText('关闭这扇窗')
    // 动作组那一格里**恰好一颗**(从前是三颗:钉到边 / 上舞台 / ✕)。
    expect(close.parentElement?.querySelectorAll(':scope > button')).toHaveLength(1)
    expect(close.closest('[data-pane-chrome]')).toBeTruthy()
    expect(within(win).queryByLabelText('钉到边')).toBeNull()
    expect(within(win).queryByLabelText('上舞台')).toBeNull()
  })

  it('叶菜单里的「钉到边 ▸」展开四条边,点一条真的钉过去', () => {
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '目录' })
    const menu = openLeafMenu(win)
    act(() => {
      fireEvent.click(within(menu).getByText('钉到边'))
    })
    const sub = screen.getByRole('menu', { name: '钉到边' })
    act(() => {
      fireEvent.click(within(sub).getByText('右边'))
    })
    expect(useStageStore.getState().placements.files).toEqual({ kind: 'edge', side: 'right' })
  })
})
