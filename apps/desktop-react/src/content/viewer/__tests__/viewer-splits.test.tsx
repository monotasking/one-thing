import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ViewerChrome, hostOwnsChrome } from '../ViewerChrome'
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
  placement,
  currentLine,
  path,
}: {
  placement: string
  currentLine: number | undefined
  path: string | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { onScroll } = useViewerScroll(ref, { currentLine, path, placement })
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
    useViewerSource.setState({ scrollTop: 0 })
  })
  afterEach(() => {
    if (originalScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop)
  })

  it('③ 每一帧滚动抄进 store —— 没有它,②就没有数可贴', () => {
    render(<ScrollHarness placement="panel" currentLine={0} path="/repo/a.ts" />)
    const body = screen.getByTestId('body')
    body.scrollTop = 260
    fireEvent.scroll(body)
    expect(useViewerSource.getState().scrollTop).toBe(260)
  })

  it('② 换宿主(placement 变)挂上来第一帧就把滚动位贴回去,不弹回顶上', () => {
    useViewerSource.setState({ scrollTop: 120 })
    const { rerender } = render(<ScrollHarness placement="panel" currentLine={0} path="/repo/a.ts" />)
    expect(screen.getByTestId('body').scrollTop).toBe(120)

    useViewerSource.setState({ scrollTop: 340 })
    rerender(<ScrollHarness placement="float" currentLine={0} path="/repo/a.ts" />)
    expect(screen.getByTestId('body').scrollTop).toBe(340)
  })

  it('② 换文件也重贴一次:同一个宿主里 .body 不重挂,内容却全换了', () => {
    useViewerSource.setState({ scrollTop: 12 })
    const { rerender } = render(<ScrollHarness placement="panel" currentLine={0} path="/repo/a.ts" />)
    useViewerSource.setState({ scrollTop: 88 })
    rerender(<ScrollHarness placement="panel" currentLine={0} path="/repo/b.ts" />)
    expect(screen.getByTestId('body').scrollTop).toBe(88)
  })

  it('① 律④ 跳行:落点之后把那一行滚到视野中间,不重挂 body', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { rerender } = render(<ScrollHarness placement="panel" currentLine={0} path="/repo/a.ts" />)
    const before = screen.getByTestId('body')
    expect(spy).not.toHaveBeenCalled()

    rerender(<ScrollHarness placement="panel" currentLine={3} path="/repo/a.ts" />)
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

/* ── 檐(切线 A 的另一半)与未保存丸的收编 ────────────────────────────── */

describe('ViewerChrome —— 身份、关闭,以及那颗迁进库件的未保存丸', () => {
  it('哪些宿主自带檐:三档合一,panel 与架子自己画', () => {
    expect(['float', 'stage', 'cover'].map(hostOwnsChrome)).toEqual([true, true, true])
    expect(['panel', 'edge-left', 'edge-right'].map(hostOwnsChrome)).toEqual([false, false, false])
  })

  it('没有身份就只剩关闭 —— 不画一枚不存在的文件的徽(axe 2.68 那条判例)', () => {
    render(<ViewerChrome t={((k: string) => k) as never} path="" name="" dirty={false} toolbar={null} onClose={() => {}} />)
    expect(screen.queryByTestId('viewer-name')).toBeNull()
    expect(screen.getByTestId('viewer-close')).toBeTruthy()
  })

  it('未保存丸消费 ui/StatusDot(不再是本地自绘的 .dirtyDot)', () => {
    render(<ViewerChrome t={((k: string) => k) as never} path="/repo/a.ts" name="a.ts" dirty toolbar={null} onClose={() => {}} />)
    const pill = screen.getByTestId('viewer-dirty')
    const dot = pill.firstElementChild as HTMLElement
    // CSS Modules 出来的是 `_dot_hash _warn_hash _sm_hash` —— 判据是「有这三段词」,
    // 三段少一段就说明它又变回了本地那颗(或者档位掉了)。
    expect(dot.className).toMatch(/_dot_/)
    expect(dot.className).toMatch(/_warn_/)
    expect(dot.className).toMatch(/_sm_/)
    // 旁边已经写着「未保存」,所以这颗点是装饰,不该再念一遍(StatusDot 的判据)。
    expect(dot.getAttribute('aria-hidden')).toBe('true')
  })

  it('本地那条 .dirtyDot 真的退役了 —— 留一条死配方等于留一个第二产地', () => {
    // 读样式表源文本的门先剥注释(CLAUDE.md:病历文本会让断言自红 ——
    // 下面那块墓碑注释里就写着 `.dirtyDot` 这个词)。
    const here = path.dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(path.join(here, '../FileViewer.module.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(css).not.toMatch(/\.dirtyDot\s*\{/)
  })
})
