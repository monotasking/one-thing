import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useViewerScroll } from '../useViewerScroll'
import { anchorAtPointer, anchorBelow, useFileFloats } from '../../file-floats'
import type { FileFloats } from '../../file-floats'
import { DETAIL_POPOVER_GAP } from '../../FileDetailPopover'
import { useViewerSource } from '../../../data/viewer-source'

/**
 * 批 9b 把查看器那 809 行拆成七件之后,**每一件的守卫**。
 *
 * 这一组与 `content/__tests__/file-viewer.test.tsx` 分工明确:那一份验的是
 * 「查看器这块面对外还是同一台机器」(56 例一字未动,拆分批的通过条件),
 * 这一份验的是**拆出来的那几件各自的契约** —— 键位表的六条命令逐条落在
 * 五个动作上、滚动三件的那条链、浮层锚点两档的算式。
 *
 * 拆一件出来却不给它自己的守卫,等于把「它现在归谁管」这件事又交回给
 * 那个大文件:下一个人改 hook 时,红的仍然只会是别人的用例。
 */

/* ── 键位派发(切线 B)—— 09-03 R2 整只退役 ───────────────────────────────
 *
 * `useViewerKeymap` 与查看器键位表那一格 `bindings` 一起删了:面域局部键从
 * 「挂在自己根元素上的监听 + 一张私有键表」变成了**作用域声明**——
 * 表在 `focus/scopes.ts` 的 `FOCUS_SCOPES.viewer.keys`,落点是 `FileViewer`
 * 交给 `<FocusScope keyHandlers>` 的那三格,路由由响应链按活动路径的深度做。
 *
 * 它从前钉的三件事各自搬去了新的产地,一件都没丢:
 *  · 「六条命令 → 五个动作」→ `keymap/__tests__/keymap-scopes.test.ts`
 *    (声明与落点逐条对表,设计 §8);
 *  · 「接住了才 preventDefault、没接住原样放行」→ `focus/__tests__/transitions.test.ts`
 *    的 routeKey 那一组(「命中了但那一格没有注入处理器 → 当作没命中」);
 *  · 「三条判据各挡各的」→ `content/__tests__/file-viewer.test.tsx`(真的按下去看)。
 */

/* ── 滚动三件(切线 C)─────────────────────────────────────────────────── */

/**
 * jsdom 不排版,所以它的 `scrollTop` setter 对一个「不可滚」的元素是空转 ——
 * 而这一组要验的恰恰是**写进去的那个数**。于是在原型上换一副按元素记账的
 * 存取器:它不模拟滚动,只把「谁被写了多少」记下来,那正是断言的对象。
 */
const scrollTops = new WeakMap<Element, number>()
let originalScrollTop: PropertyDescriptor | undefined

function ScrollHarness({
  currentLine,
  path,
}: {
  currentLine: number | undefined
  path: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { onScroll } = useViewerScroll(ref, { currentLine, path })
  return (
    <div data-testid="body" ref={ref} onScroll={onScroll}>
      <span data-line="3">third</span>
    </div>
  )
}

describe('useViewerScroll —— 抄进去 / 贴回来 / 跳过去', () => {
  beforeEach(() => {
    originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return scrollTops.get(this) ?? 0
      },
      set(this: Element, v: number) {
        scrollTops.set(this, v)
      },
    })
    useViewerSource.getState().reset()
  })
  afterEach(() => {
    if (originalScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop)
  })

  it('③ 每一帧滚动抄进 store —— 没有它,②就没有数可贴', () => {
    render(<ScrollHarness currentLine={0} path="/repo/a.ts" />)
    const body = screen.getByTestId('body')
    body.scrollTop = 260
    fireEvent.scroll(body)
    expect(useViewerSource.getState().scrolls['/repo/a.ts']).toBe(260)
  })

  it('② 换宿主(这棵树真重挂)挂上来第一帧就把滚动位贴回去,不弹回顶上', () => {
    useViewerSource.setState({ scrolls: { '/repo/a.ts': 120 } })
    const { unmount } = render(<ScrollHarness currentLine={0} path="/repo/a.ts" />)
    expect(screen.getByTestId('body').scrollTop).toBe(120)
    /*
     * W1:`placement` 那个 prop 没有了 —— 查看器不再知道自己被摆在哪儿。
     * 「换宿主」这件事本来就是一次**真重挂**(新的组件实例,layout effect 自然重跑),
     * 不需要一个字符串来提醒它。所以这里换成真的卸载再挂一次。
     */
    unmount()
    useViewerSource.setState({ scrolls: { '/repo/a.ts': 340 } })
    render(<ScrollHarness currentLine={0} path="/repo/a.ts" />)
    expect(screen.getByTestId('body').scrollTop).toBe(340)
  })

  it('②b 两份实例各贴各的数(多实例不串)', () => {
    useViewerSource.setState({ scrolls: { '/repo/a.ts': 120, '/repo/b.ts': 340 } })
    render(<ScrollHarness currentLine={0} path="/repo/a.ts" />)
    expect(screen.getByTestId('body').scrollTop).toBe(120)

  })

  it('② 换文件也重贴一次:同一个宿主里 .body 不重挂,内容却全换了', () => {
    useViewerSource.setState({ scrolls: { '/repo/a.ts': 12, '/repo/b.ts': 88 } })
    const { rerender } = render(<ScrollHarness currentLine={0} path="/repo/a.ts" />)
    rerender(<ScrollHarness currentLine={0} path="/repo/b.ts" />)
    expect(screen.getByTestId('body').scrollTop).toBe(88)
  })

  it('① 律④ 跳行:落点之后把那一行滚到视野中间,不重挂 body', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { rerender } = render(<ScrollHarness currentLine={0} path="/repo/a.ts" />)
    const before = screen.getByTestId('body')
    expect(spy).not.toHaveBeenCalled()

    rerender(<ScrollHarness currentLine={3} path="/repo/a.ts" />)
    expect(spy).toHaveBeenCalledWith({ block: 'center' })
    // 零重挂:滚过去不许换掉那个 DOM 节点(四律④ 的另一半)。
    expect(screen.getByTestId('body')).toBe(before)
    spy.mockRestore()
  })
})

/* ── 文件浮层锚点(切线 D)─────────────────────────────────────────────── */

describe('file-floats —— 两档锚各是一条算式', () => {
  it('点锚:光标那一点就是落点,不加缝(右键菜单)', () => {
    expect(anchorAtPointer({ clientX: 40, clientY: 90 })).toEqual({ x: 40, y: 90 })
  })

  it('矩锚:贴左下角,隔一条 DETAIL_POPOVER_GAP', () => {
    const rect = { left: 12, bottom: 200 } as DOMRect
    expect(anchorBelow(rect)).toEqual({ x: 12, y: 200 + DETAIL_POPOVER_GAP })
  })

  it('从一层浮层长出下一层:同样隔一条缝(查看器今天的行为,逐像素保住)', () => {
    expect(anchorBelow({ x: 7, y: 33 })).toEqual({ x: 7, y: 33 + DETAIL_POPOVER_GAP })
  })

  it('取不到矩时如实落在 (0, GAP) —— 与迁移前两面逐字相同,不编一个屏幕中央', () => {
    expect(anchorBelow(null)).toEqual({ x: 0, y: DETAIL_POPOVER_GAP })
  })

  it('两格各开各的、各关各的:菜单收了详情不跟着收(详情是从菜单里长出来的)', () => {
    let api!: FileFloats
    function Harness() {
      api = useFileFloats()
      return null
    }
    render(<Harness />)
    expect(api.menuAt).toBeNull()
    expect(api.detailAt).toBeNull()

    act(() => api.openMenuAt({ clientX: 5, clientY: 6 }))
    expect(api.menuAt).toEqual({ x: 5, y: 6 })

    act(() => api.openDetailAt(api.menuAt))
    expect(api.detailAt).toEqual({ x: 5, y: 6 + DETAIL_POPOVER_GAP })

    act(() => api.closeMenu())
    expect(api.menuAt).toBeNull()
    expect(api.detailAt).toEqual({ x: 5, y: 6 + DETAIL_POPOVER_GAP })
  })
})

/* ── 檐退役(W1:一格一檐)───────────────────────────────────────────────── */

describe('ViewerChrome / HOST_OWNS_CHROME —— 整件退役', () => {
  /**
   * 规则现在只有一条:**一片叶只有一条檐,那条檐就是 tab 条;内容自己不画檐。**
   * 于是 `ViewerChrome.tsx` 与那张 `HOST_OWNS_CHROME` 表一起删了 —— 后者本来就是
   * 「谁画檐」这个问题没有唯一答案时的补丁。
   *
   * 这一组用**文件在不在**与**源文本里有没有那两个词**钉它,而不是 import 它
   * (import 一个已经删掉的模块是编译期错误,写不出这条用例)。
   */
  const here = path.dirname(fileURLToPath(import.meta.url))
  const viewerDir = path.join(here, '..')

  it('那两件源文件真的不在了', () => {
    expect(existsSync(path.join(viewerDir, 'ViewerChrome.tsx'))).toBe(false)
    expect(existsSync(path.join(viewerDir, 'ViewerPanel.tsx'))).toBe(false)
  })

  it('查看器身上不再有 placement / chromeless / HOST_OWNS_CHROME 这三格', () => {
    // 读源文本的门**先剥注释**(CLAUDE.md:病历文本会让断言自红 —— 文件头那段
    // 判例里就逐字写着这三个词)。
    const src = readFileSync(path.join(viewerDir, 'FileViewer.tsx'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/HOST_OWNS_CHROME/)
    expect(src).not.toMatch(/chromeless/)
    expect(src).not.toMatch(/placement/)
  })

  it('本地那条 .dirtyDot 仍然是退役的 —— 留一条死配方等于留一个第二产地', () => {
    const css = readFileSync(path.join(viewerDir, 'FileViewer.module.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(css).not.toMatch(/\.dirtyDot\s*\{/)
  })
})
