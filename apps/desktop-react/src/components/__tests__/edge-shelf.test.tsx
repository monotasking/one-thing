import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageState, SHELF_DEFAULT_THICKNESS } from '../../stage/transitions'
import { useWorkbenchStore } from '../../workbench/store'
import type { ShelfSide } from '../../stage/types'
import { focusTree } from '../../focus/registry'

/**
 * 四边架子的挂载路径:形态机说「它在某条边上」,外壳就该在那条边画出一条架子。
 * 厚度算术与吸附判定在 transitions 的纯函数里测(那里能给定视口),
 * 这里只钉四件事:哪条边有 tab 就画哪条、空的一条都不画、收得起来、点细梁展得开。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  /*
   * **两台 store 都要归零**(W4):架子上有什么从今天起住在拼贴树里
   * (`workbench.regions['edge:<side>']`),`placements` 只是它的投影。
   * 只归零 stage 的话,上一例摆的那条架子会跟着走进这一例 ——
   * 「空架子不渲染」那条当场读到两条 aside。
   */
  useWorkbenchStore.getState().reset()
})

afterEach(() => {
  focusTree.reset()
})

/** store 在 React 事件之外被推动,所以得进 act —— 否则断言会读到上一帧。 */
function openOnEdge(id: string, side: ShelfSide) {
  act(() => useStageStore.getState().openAs(id, { kind: 'edge', side }))
}

/**
 * 一发带 `button` / `clientX` 的指针事件。jsdom 没有 `PointerEvent` 构造器,
 * `fireEvent.pointerDown` 派出来的裸 `Event` 的 `button` 是 undefined,会被
 * 「只认主键」那条闸挡掉(判据与 `ui/__tests__/drag-session.test.tsx` 同源)。
 */
const pointerAt = (type: string, x = 0, y = 0) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })

const NAME: Record<ShelfSide, string> = {
  left: '左侧栏',
  right: '右侧栏',
  bottom: '底栏',
}

/**
 * 视口是**共同预算**的分母(W7-p 裁定 3),所以四条边那两例必须自己说清楚窗子多大 ——
 * jsdom 的出厂视口是 1024×768,在那台窗子里「四条边各钉 400」本来就摆不下
 * (1024 − 中央最小 480 = 544,两条竖边分不到两个 240)。
 *
 * **竖轴还要先扣顶栏**(W7-p 修一轮裁定 6):可用高度是 `视口高 − 44`,所以
 * 1000 高的窗里「上 400 + 下 400」差 4px 就摆不下(1000 − 44 − 320 − 400 = 236 < 240)。
 * 1100 是「四条边都摆得下」的那一档,不是随手加的高度。
 */
function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
}

describe('四边架子', () => {
  afterEach(() => setViewport(1024, 768))

  it('三条边各挂一个:哪条边上有 tab 就画哪一条(顶架子已退役)', () => {
    // 摆得下的窗子里才问「画不画」—— 摆不下那一档是下面那一例的事。
    setViewport(1600, 1100)
    render(<AppShell />)
    openOnEdge('files', 'left')
    openOnEdge('diff', 'right')
    openOnEdge('browser', 'bottom')
    for (const side of ['left', 'right', 'bottom'] as ShelfSide[]) {
      expect(screen.getByRole('complementary', { name: NAME[side] })).toBeTruthy()
    }
  })

  /**
   * **摆不下就拒绝,不许把中央区压成 0**(W7-p 裁定 3,审计 A 的 A3:真机上四边
   * 各钉 400,中央区量到 h = 0,输入框浮在上架子的内容上)。
   *
   * 反证:把 `placeAs` 的 edge 支里那句 `canNailShelf` 拆掉 → 右架子照样画出来,
   * 这一条当场红。
   */
  it('对边摆不下时拒绝并保持原样:窄窗里钉了左边就钉不上右边', () => {
    setViewport(1024, 768)
    render(<AppShell />)
    openOnEdge('files', 'left')
    openOnEdge('diff', 'right')
    expect(screen.getByRole('complementary', { name: NAME.left })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: NAME.right })).toBeNull()
    // 拒绝 = **一格状态都不写**:那块瓦仍旧在 Dock 里,不是「开了但没画」。
    expect(useStageStore.getState().shelves.right.tabs).toEqual([])
  })

  it('空架子不渲染 —— 也就不占一丝布局', () => {
    render(<AppShell />)
    expect(screen.queryByRole('complementary')).toBeNull()
    openOnEdge('files', 'bottom')
    expect(screen.getAllByRole('complementary')).toHaveLength(1)
    expect(screen.getByRole('complementary', { name: NAME.bottom })).toBeTruthy()
  })

  /**
   * **收起 = 形态变了,不是内容没了**(2026-09-12 用户拍「收起 ≠ 关闭」)。
   *
   * 这一条从前断的是「tab 条与内容都不在了」—— 那时收起真的把整棵 `PaneTree`
   * 连同每一格内容子树卸载掉,展开时从零重建。今天它断的是同一件事的**新答案**:
   * 屏幕上只看得见细梁(形态口 `data-shelf-collapsed` 在场、展开钮在),而树身
   * 仍旧挂着 —— 那正是「收起来再展开,滚动位与内部状态一格不丢」的机械含义。
   * 收起态的树身**必须 `inert`**,否则它的局部键会在看不见的地方响。
   */
  it('收起 = 细梁在、形态口在;树身仍挂着但 inert', () => {
    render(<AppShell />)
    openOnEdge('files', 'bottom')
    const shelf = screen.getByRole('complementary', { name: NAME.bottom })
    fireEvent.click(screen.getByLabelText('收起底栏'))
    expect(useStageStore.getState().shelves.bottom.collapsed).toBe(true)
    expect(shelf.hasAttribute('data-shelf-collapsed')).toBe(true)
    expect(screen.getByLabelText('展开底栏')).toBeTruthy()
    // 树身没走:tab 条还在 DOM 里,整格被 `inert` 移出焦点序与辅助树。
    const body = shelf.querySelector('[data-shelf-body="bottom"]') as HTMLElement
    expect(body).toBeTruthy()
    expect(body.hasAttribute('inert')).toBe(true)
    expect(within(body).queryAllByRole('tab', { hidden: true }).length).toBeGreaterThan(0)
  })

  it('点细梁展开回去,tab 次序与活动 tab 一个都没动', () => {
    render(<AppShell />)
    openOnEdge('files', 'left')
    openOnEdge('diff', 'left')
    fireEvent.click(screen.getByLabelText('收起左侧栏'))
    fireEvent.click(screen.getByLabelText('展开左侧栏'))
    const shelf = useStageStore.getState().shelves.left
    expect(shelf.collapsed).toBe(false)
    expect(shelf.tabs).toEqual(['files', 'diff'])
    expect(shelf.activeId).toBe('diff')
  })
})

/**
 * keep-alive(08-30):同一条架子上的一组 tab **全部保持挂载**,切 tab 只换哪一层显形。
 * 这里钉的是它的三条边界 —— 别的都在门里量(gate-perf 场景②:延迟、长帧、滚动位置)。
 */
/**
 * **檐上只剩「收起」**(W7-c 裁定 4;用户 09-05「按钮太多」)。
 *
 * 「弹出为浮窗」与「关闭整栏」搬进了这片叶的动作菜单,开口是右键**这条架子的
 * 檐**(标签条右边那片空白)。三条断言各管一半:
 *  · 檐上恰好一颗钮,而且是「收起」——多一颗就是减法白做了;
 *  · 那两行在菜单里(名字逐字是从前那两颗钮上的话);
 *  · 点它们**真的做那件事** —— 调的是与从前那两颗钮**同一只** store 动作
 *    (`edgeToFloat` / `closeShelf`),两条路走两个动作迟早分叉。
 */
describe('架子檐:只剩「收起」,弹出与关整栏进叶菜单', () => {
  /** 右键这条架子的檐 = 开它的叶菜单。 */
  function leafMenu(side: ShelfSide) {
    /* 取件口是 `data-shelf`(与门那一头同一格判例:文案会跟着语言变,这一格不会)。 */
    const shelf = document.querySelector(`[data-shelf="${side}"]`) as HTMLElement
    const chrome = shelf.querySelector('[data-pane-chrome]') as HTMLElement
    act(() => {
      fireEvent.contextMenu(chrome, { clientX: 10, clientY: 10 })
    })
    return screen.getByRole('menu', { name: '标签动作' })
  }

  it('檐右端只有一颗钮,而且是「收起」', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    const collapse = screen.getByLabelText(`收起${NAME.right}`)
    expect(collapse.parentElement?.querySelectorAll(':scope > button')).toHaveLength(1)
    expect(collapse.closest('[data-pane-chrome]')).toBeTruthy()
    expect(screen.queryByLabelText(`弹出 ${NAME.right} 为浮窗`)).toBeNull()
    expect(screen.queryByLabelText(`关闭整栏 ${NAME.right}`)).toBeNull()
  })

  it('叶菜单里的「弹出为浮窗」:瓦的架子弹出去,与从前那颗钮走 edgeToFloat 同一个结果', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    const menu = leafMenu('right')
    act(() => {
      fireEvent.click(within(menu).getByText(`弹出 ${NAME.right} 为浮窗`))
    })
    expect(useStageStore.getState().placements.files).toEqual({ kind: 'float' })
  })

  /**
   * **只装着文件的架子也弹得出去**(2026-09-14,与浮窗那头「钉到边 ▸」同一个病的反向):
   * 从前这一行读 `activeItemId`,根叶活动格不是瓦就整行灰着 —— 浏览器 / 文件的架子
   * 从此弹不成窗。反证:把 `EdgeShelf` 那一行换回 `disabled={activeItemId === null}` +
   * `edgeToFloat(activeItemId)` → 这条当场红。
   */
  it('只装着文件的架子:「弹出为浮窗」不灰,点了整条架子进一扇新窗', () => {
    render(<AppShell />)
    act(() => {
      useStageStore.getState().placeRef({ kind: 'file', key: '/tmp/a.md' }, 'edge:right')
    })
    const menu = leafMenu('right')
    const row = within(menu).getByText(`弹出 ${NAME.right} 为浮窗`).closest('button')
    expect(row).toHaveProperty('disabled', false)
    act(() => {
      fireEvent.click(row as HTMLElement)
    })
    expect(useWorkbenchStore.getState().regions['edge:right']).toBeUndefined()
    const win = useStageStore.getState().floatOrder[0]
    expect(win?.startsWith('win-')).toBe(true)
    expect(useWorkbenchStore.getState().regions[`float:${win}`]).toBeTruthy()
  })

  it('叶菜单里的「关闭整栏」= 从前那颗钮走的 closeShelf', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    const menu = leafMenu('right')
    act(() => {
      fireEvent.click(within(menu).getByText(`关闭整栏 ${NAME.right}`))
    })
    // 整栏关掉 = 那棵树没了,瓦回 Dock(投影里就是「哪儿都不在」)。
    expect(useWorkbenchStore.getState().regions['edge:right']).toBeUndefined()
    expect(useStageStore.getState().placements.files).toBeUndefined()
  })
})

describe('同组 tab 是 keep-alive 的', () => {
  /*
   * W4:一格 tab 的那一层从架子自己那份 `ShelfTabLayer` 换成了树的
   * `PaneLeaf` → `PaneTabLayer`(判词在 `EdgeShelf.module.css` 里那段退役注)。
   * 取件口因此从 `data-panel-layer=<瓦 id>` 换成 `data-pane-tab=<refId>`;
   * **这一组要守的三条边界一个字没改**(不卸载 / inert 说两遍 / 同一个 DOM 节点)。
   */
  const layer = (id: string) => document.querySelector(`[data-pane-tab="panel:${id}"]`)
  /** 这一格此刻在不在**这条架子**里(浮窗也画 `data-pane-tab`,所以要限定容器)。 */
  const layerInShelf = (side: ShelfSide, id: string) =>
    document.querySelector(`[data-shelf-body="${side}"] [data-pane-tab="panel:${id}"]`)

  it('切走的那一块不卸载:两层都在,非活动那层 inert', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('terminal', 'right')
    expect(useStageStore.getState().shelves.right.activeId).toBe('terminal')
    expect(layer('files')).toBeTruthy()
    expect(layer('terminal')).toBeTruthy()
    expect(layer('files')!.hasAttribute('inert')).toBe(true)
    expect(layer('terminal')!.hasAttribute('inert')).toBe(false)
  })

  /**
   * **`inert` 要说两遍,而且必须是同一个判据**(09-02 R1)。
   * 一遍给 DOM(上面那条:浏览器据此把这一层移出焦点序与辅助树),一遍给树 ——
   * 注册表据此不选它当第一响应者,**路径经过它就在那儿截断**。
   * 少了给树的那一遍,后台那层照样能当第一响应者,它的局部键会在看不见的地方响;
   * 而「切 tab 之后焦点变孤儿」(I1)那条也就没人接得住。
   * 反证:把 `<FocusScope scope="shelf-layer" inert={!on}>` 的 `inert` 摘掉 → 本条红。
   */
  it('每一层都是树上的一格 shelf-layer,而且 inert 与 DOM 那一遍**同一个判据**', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('terminal', 'right')

    for (const id of ['files', 'terminal']) {
      expect(layer(id)!.getAttribute('data-focus-scope')).toBe('leaf')
    }
    /*
     * W4 起层次是**两级**:整条架子一格 `shelf-layer`(住户 = 它露脸的那格瓦 ——
     * 召唤与跟焦按 `owner` 精确取它),里面每一格 tab 一格 `leaf`。
     * 「后台那格不可当第一响应者」这条判据一个字没改,只是落在 `leaf` 上了。
     */
    const shelves = focusTree.dump().nodes.filter((n) => n.scope === 'shelf-layer')
    expect(shelves.length).toBe(1)
    expect(shelves[0].owner).toBe('terminal')
    // 一格叶根 + 两格 tab 层:活动那格可交互,切走那格 inert。
    const tabs = focusTree.dump().nodes.filter((n) => n.scope === 'leaf' && n.owner?.startsWith('panel:'))
    expect(tabs.length).toBe(2)
    expect(tabs.filter((n) => n.inert).length).toBe(1)
    expect(tabs.filter((n) => !n.inert).length).toBe(1)
  })

  it('切回来是**同一个 DOM 节点** —— 这就是「内部状态与滚动位置不丢」的机械含义', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    const before = layer('files')
    openOnEdge('terminal', 'right')
    act(() => useStageStore.getState().activateShelfTab('right', 'files'))
    expect(layer('files')).toBe(before)
    expect(layer('files')!.hasAttribute('inert')).toBe(false)
  })

  it('边界只画到这一组:离开这条架子的那一块当场卸载', () => {
    render(<AppShell />)
    openOnEdge('files', 'right')
    openOnEdge('terminal', 'right')
    act(() => useStageStore.getState().closeToDock('terminal'))
    expect(layer('terminal')).toBeNull()
    expect(layer('files')).toBeTruthy()
    act(() => useStageStore.getState().edgeToFloat('files'))
    /*
     * W4:撕成浮窗之后这一格**并没有消失** —— 它换了个宿主(浮窗的身子也是一棵树,
     * 画的也是 `data-pane-tab`)。这一条守的一直是「**这条架子**上不再有它」,
     * 所以按容器限定;整条架子随之空掉、整个 `<aside>` 卸载,那是同一件事的另一面。
     */
    expect(layerInShelf('right', 'files')).toBeNull()
    expect(document.querySelector('[data-shelf="right"]')).toBeNull()
    expect(layer('files')).toBeTruthy()
  })
})

/**
 * **厚度把手:取消不落定**(U5,2026-09-08)。
 *
 * 三条取消路(Esc / pointercancel / 窗口失焦)由 `ui/drag` 的 `PointerTrack` 统一收;
 * 这一头的取消动作只有一句 `setLiveThickness(null)` —— 渲染当场回到 store 那份,
 * `setShelfThickness` 一个字都不落。从前这条把手压根没有 Esc、也收不到窗口失焦
 * (监听挂在把手自己身上,capture 一丢就聋):拖到一半 Cmd-Tab 切走应用,那格活厚度
 * 就一直挂着,直到下一次恰好在同一个把手上松手。
 *
 * **断言两头都要问**:取消这条路本来就不写 store,只问 store 的话「一句 cancel 都
 * 没有」也是绿的 —— 那时活厚度仍旧挂着,屏幕上这条架子就停在半路。所以既问
 * 屏幕上那条 `<aside>` 有多厚,也问 store 那一格。
 * **还要与松手那条路对照着看**:只断「取消之后厚度没变」会被一次空动作蒙混过去
 * (指针没走、厚度本来就没变),所以第一条先证明同一串手势在松手时**真的**改了厚度。
 * 反证:把 `cancel` 换成 `end` 那一只 → 三条全红;把 `cancel` 整只挖掉 → 同样三条红
 * (屏幕上那条架子停在 300px 上)。
 */
describe('厚度把手的三条结束路径', () => {
  afterEach(() => setViewport(1024, 768))

  /** 起一条左侧架子并按住它的厚度把手,答那颗把手。 */
  function grabHandle() {
    setViewport(1600, 1100)
    render(<AppShell />)
    openOnEdge('files', 'left')
    const handle = screen.getByRole('separator', { name: '调整左侧栏厚度' })
    act(() => {
      fireEvent(handle, pointerAt('pointerdown'))
      handle.dispatchEvent(pointerAt('pointermove', 300))
    })
    return handle
  }

  const thicknessNow = () => useStageStore.getState().shelves.left.thickness
  /** **屏幕上**这条架子此刻有多厚 —— 取消要还原的正是它(store 那一份从没被碰过)。 */
  const paintedNow = () => screen.getByRole('complementary', { name: NAME.left }).style.width

  it('松手 = 落定:store 里那格厚度换成了指针给的那个数', () => {
    const handle = grabHandle()
    act(() => { handle.dispatchEvent(pointerAt('pointerup', 300)) })
    expect(thicknessNow()).toBe(300)
    expect(paintedNow()).toBe('300px')
  })

  const cancels: Array<[string, (handle: HTMLElement) => void]> = [
    ['窗口失焦', () => window.dispatchEvent(new Event('blur'))],
    ['pointercancel', (handle) => handle.dispatchEvent(pointerAt('pointercancel', 300))],
    [
      'Esc(经 focus 树的瞬态口)',
      () => {
        const all = focusTree.transientEscapeHandlers()
        all[all.length - 1]?.()
      },
    ],
  ]
  for (const [name, fire] of cancels) {
    it(`拖到一半${name}:屏幕与 store 一起回到拖之前那个数`, () => {
      const handle = grabHandle()
      // 拖到一半:屏幕上已经不是 store 那一份了(不然下面那条断言是空的)。
      expect(paintedNow()).toBe('300px')
      act(() => { fire(handle) })
      expect(paintedNow()).toBe(`${SHELF_DEFAULT_THICKNESS}px`)
      expect(thicknessNow()).toBe(SHELF_DEFAULT_THICKNESS)
      // 而且这一场真的死了:再来一发 pointerup 也不会补落一次。
      act(() => { handle.dispatchEvent(pointerAt('pointerup', 300)) })
      expect(paintedNow()).toBe(`${SHELF_DEFAULT_THICKNESS}px`)
      expect(thicknessNow()).toBe(SHELF_DEFAULT_THICKNESS)
    })
  }
})

/*
 * ── 檐上标签也进格子(09-13 侧栏对齐律 §8 第 6 条)─────────────────────────
 * jsdom 不排版,所以这里判的是**规则本身**(真的几何由 `gate:sessions` ① 那条
 * 「檐上第一枚 svg 的中心 = 线」量)。两条:让位的数从线推(零字面量),
 * 而且**只有左架子声明它** —— 别的三个宿主左边没有红绿灯,给它们让位就是
 * 凭空歪一格。
 */
describe('檐上标签的图标也以那条线为中心(§8 第 6 条)', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  const read = (rel: string) =>
    strip(readFileSync(resolve(__dirname, rel), 'utf-8'))
  const block = (src: string, selector: string) =>
    src.slice(src.indexOf(selector)).split('}')[0]

  it('左架子声明 --strip-lead,数从 --content-lead-left 推(零字面量)', () => {
    const shelf = read('../EdgeShelf.module.css')
    /* 线 − 一只肩 − 半枚 tab 图标。减「肩」而不是「条的左内边距」:那两件在
       joined 档里是同一个数,第一格 tab 的左缘就落在一只肩之后。 */
    expect(block(shelf, '.sideLeft {')).toMatch(
      /--strip-lead:\s*calc\(var\(--content-lead-left\) - var\(--tab-shoulder\) - var\(--tab-icon\) \/ 2\)/,
    )
  })

  it('右 / 上 / 下三条架子**不**声明它(它们左边没有灯)', () => {
    const shelf = read('../EdgeShelf.module.css')
    for (const side of ['.sideRight {', '.sideTop {', '.sideBottom {']) {
      expect(block(shelf, side), side).not.toMatch(/--strip-lead/)
    }
    // 全文件只有一处产地。
    expect(shelf.match(/--strip-lead:/g)?.length).toBe(1)
  })

  it('落地的是**第一格 tab 的左内衬**,缺省 --tab-pad-x —— 别的宿主一个像素不变', () => {
    const stripCss = read('../../workbench/LeafStrip.module.css')
    expect(block(stripCss, ".tabs > * > [role='tab']:first-child {")).toMatch(
      /padding-inline-start:\s*var\(--strip-lead,\s*var\(--tab-pad-x\)\)/,
    )
    /*
     * **不许落在条的左内边距上**(真机量出来的,gate:sessions ① 第一趟就红了):
     * `.bar[data-look='joined']` 的 `padding-inline: var(--tab-shoulder)` 不是留白,
     * 是「活动 tab 的肩永远在条里」的结构保证 —— 压到 6 会裁掉 3px 的肩。
     * 也不许落在 `.chrome` 上(它是檐的底,让位会在左边留一段别的颜色)。
     */
    expect(block(stripCss, '.tabs > * {')).not.toMatch(/padding-inline/)
    expect(block(stripCss, '.chrome {')).not.toMatch(/padding-inline/)
  })
})
