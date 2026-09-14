import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { useWorkbenchStore } from '../../workbench/store'
import { refId } from '../../workbench/kinds'
import { initialStageState } from '../../stage/transitions'
import { focusTree } from '../../focus/registry'
import { nextFloatId } from '../../stage/placement'
import { floatRegion } from '../../workbench/regions'
import { leavesOf } from '../../workbench/tree'

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

/**
 * **拖窗:取消不落定**(U5,2026-09-08)。
 *
 * 三条取消路(Esc / pointercancel / 窗口失焦)由 `ui/drag` 的 `PointerTrack` 统一收;
 * 这一头的取消动作只有一句清场(`liveRef` / `live` / `setSnapSide` 归零),
 * `moveFloat` / `resizeFloat` / `floatToEdge` 一个都不叫 —— 渲染当场回到 `stored`
 * 那份,窗子滑回按下那一刻。从前这扇窗压根没有 Esc、也收不到窗口失焦
 * (监听挂在按下的那个元素上,capture 一丢就聋):拖到一半 Cmd-Tab 切走应用,
 * 那格活矩形与吸边预示会一直挂着 —— **屏幕上那扇窗就停在半路**,而 store 里
 * 那一份从头到尾没被碰过。
 *
 * **所以断言必须落在屏幕上那份矩形上,不能只问 store**:取消这条路本来就不写
 * store,只问 store 的话「一句 cancel 都没有」也是绿的(第一版当场被反证抓到:
 * 把 `cancel: clearLive` 整只挖掉,12 条全绿)。今天两头都问 ——
 * 屏幕回到拖前那一份 ∧ store 一个字没动。
 *
 * **与松手那条路对照着量**:只断「取消之后位置没变」会被一次空动作蒙混过去,
 * 所以第一条先证明同一串手势在松手时**真的**把窗挪走了。
 * 反证:把 `begin` 里那只 `cancel: clearLive` 挖掉 → 三条取消路全红(屏幕上那扇窗
 * 停在 560,340 那一程上)。
 */
describe('拖窗的三条结束路径', () => {
  /** 视口要够大 —— `clampFloatRect` 会把窗钳回视口,窗子挪不动就量不到东西。 */
  function setViewport(w: number, h: number) {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
  }
  afterEach(() => setViewport(1024, 768))

  const pointerAt = (type: string, x = 0, y = 0) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })

  /** 起一扇浮窗、按住它的标题栏空白处、往右下走一段。答那条檐。 */
  function grabChrome() {
    setViewport(1600, 1100)
    render(<AppShell />)
    openFloat('files')
    const win = screen.getByRole('dialog', { name: '目录' })
    const chrome = win.querySelector('[data-pane-chrome]') as HTMLElement
    act(() => {
      fireEvent(chrome, pointerAt('pointerdown', 500, 300))
      chrome.dispatchEvent(pointerAt('pointermove', 560, 340))
    })
    return chrome
  }

  const rectNow = () => useStageStore.getState().floats.files
  /** **屏幕上**那扇窗此刻画在哪 —— 取消要还原的正是它(store 那一份从没被碰过)。 */
  const paintedNow = () => {
    const win = screen.getByRole('dialog', { name: '目录' })
    return { left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height }
  }
  const paintedOf = (r: { x: number; y: number; w: number; h: number }) => ({
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.w}px`,
    height: `${r.h}px`,
  })

  it('松手 = 落定:store 里那扇窗真的挪到了指针走过的那一段', () => {
    const chrome = grabChrome()
    const before = rectNow()
    act(() => { chrome.dispatchEvent(pointerAt('pointerup', 560, 340)) })
    const after = rectNow()
    expect(after.x).not.toBe(before.x)
    expect(after.y).not.toBe(before.y)
  })

  const cancels: Array<[string, (chrome: HTMLElement) => void]> = [
    ['窗口失焦', () => window.dispatchEvent(new Event('blur'))],
    ['pointercancel', (chrome) => chrome.dispatchEvent(pointerAt('pointercancel', 560, 340))],
    [
      'Esc(经 focus 树的瞬态口)',
      () => {
        const all = focusTree.transientEscapeHandlers()
        all[all.length - 1]?.()
      },
    ],
  ]
  for (const [name, fire] of cancels) {
    it(`拖到一半${name}:屏幕上那扇窗滑回拖之前那一份,一个字都不落 store`, () => {
      const chrome = grabChrome()
      const before = rectNow()
      // 拖到一半:屏幕上已经不是 store 那一份了(不然下面那条断言是空的)。
      expect(paintedNow()).not.toEqual(paintedOf(before))
      act(() => { fire(chrome) })
      expect(paintedNow()).toEqual(paintedOf(before))
      expect(rectNow()).toEqual(before)
      // 而且这一场真的死了:再来一发 pointerup 也不会补落一次。
      act(() => { chrome.dispatchEvent(pointerAt('pointerup', 560, 340)) })
      expect(paintedNow()).toEqual(paintedOf(before))
      expect(rectNow()).toEqual(before)
    })
  }
})

/**
 * **非瓦的窗也钉得到边上**(2026-09-14 报障「浏览器无法拖拽到四处的架子上,
 * 拖过去又回到原位」)。
 *
 * 病根:拖窗 `end` 那句从前调 `floatToEdge(id, landing)`,`id` 是**窗号**,而那一只
 * 说的是瓦的话 —— `placements` 只按瓦 id 记,`win-…` 查无此人,当场 `return`,
 * 一格状态都不写,松手后窗滑回 `stored`。浏览器 / 终端 / 文件 / diff 的窗全是
 * `nextFloatId` 铸的号,所以全都钉不上;瓦撕出来的窗窗号就是瓦 id,所以只有它们
 * 钉得上,这条病在 `openFloat('files')` 那一族用例里永远量不到。
 *
 * 这里用一份**文件**的窗(与浏览器同是「窗号 ≠ 瓦 id」那一类;判据里一个种类名
 * 都没有,所以一种就够)。两条路同一只 `floatWindowToEdge`:拖到边带松手、标题栏
 * 菜单「钉到边 ▸」(从前后者对非瓦的窗整组灰着 —— 同一个病)。
 *
 * 反证:把 `FloatWindow` 拖窗 `end` 里 `floatWindowToEdge(id, landing)` 换回
 * `floatToEdge(id, landing)` → 第一条红(文件还在窗里);把菜单那组换回
 * `activeItemId && floatToEdge(activeItemId, …)` + `disabled={activeItemId === null}`
 * → 第二条红(菜单项灰着 / 点了没反应)。
 */
describe('非瓦的窗(窗号 ≠ 瓦 id)钉到边', () => {
  function setViewport(w: number, h: number) {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
  }
  afterEach(() => setViewport(1024, 768))

  const pointerAt = (type: string, x = 0, y = 0) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })

  const tabIdsOf = (region: string): string[] => {
    const tree = useWorkbenchStore.getState().regions[region]
    return tree ? leavesOf(tree).flatMap((leaf) => leaf.tabs.map(refId)) : []
  }

  /** 铸一扇装着一份文件的窗,答窗号与它的对话框。 */
  function openFileFloat() {
    const win = nextFloatId()
    act(() => {
      useStageStore.getState().placeRef({ kind: 'file', key: '/tmp/a.md' }, floatRegion(win), {
        rect: { x: 400, y: 200, w: 600, h: 400 },
      })
    })
    const body = document.querySelector(`[data-pane-region="${floatRegion(win)}"]`) as HTMLElement
    const dialog = body.closest('[role="dialog"]') as HTMLElement
    return { win, dialog }
  }

  it('拖到右边带里松手:文件进了右架子,这扇窗没了', () => {
    setViewport(1600, 1100)
    render(<AppShell />)
    const { win, dialog } = openFileFloat()
    expect(tabIdsOf(floatRegion(win))).toEqual(['file:/tmp/a.md'])
    const chrome = dialog.querySelector('[data-pane-chrome]') as HTMLElement
    act(() => {
      fireEvent(chrome, pointerAt('pointerdown', 500, 300))
      chrome.dispatchEvent(pointerAt('pointermove', 1590, 300))
    })
    act(() => { chrome.dispatchEvent(pointerAt('pointerup', 1590, 300)) })
    expect(tabIdsOf('edge:right')).toEqual(['file:/tmp/a.md'])
    expect(useWorkbenchStore.getState().regions[floatRegion(win)]).toBeUndefined()
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
  })

  it('标题栏菜单「钉到边 ▸」对文件的窗不灰,点一条真的钉过去', () => {
    setViewport(1600, 1100)
    render(<AppShell />)
    const { win, dialog } = openFileFloat()
    const menu = openLeafMenu(dialog)
    const entry = within(menu).getByText('钉到边')
    expect(entry.closest('[aria-disabled="true"]')).toBeNull()
    act(() => { fireEvent.click(entry) })
    const sub = screen.getByRole('menu', { name: '钉到边' })
    act(() => { fireEvent.click(within(sub).getByText('左边')) })
    expect(tabIdsOf('edge:left')).toEqual(['file:/tmp/a.md'])
    expect(useWorkbenchStore.getState().regions[floatRegion(win)]).toBeUndefined()
  })
})
