import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useT } from '../../i18n'
import { FILES_ROW_H } from '../../data/files-source'
import { ButtonBase } from '../../ui/ButtonBase'
import { anchorBeside } from '../file-floats'
import type { BesideAnchor } from '../file-floats'
import { useRowWindow } from '../files/useRowWindow'
import { TreeEntryRow } from '../files/TreeEntryRow'
import type { EntryRow } from '../files/TreeEntryRow'
import { NoWorkdirNotice } from '../files/NoWorkdirNotice'
import { sessionMutation, useSessionsSource } from '../../data/sessions-source'
import { configureSessionsPort } from '../../data/sessions-port'
import type { SessionsPort } from '../../data/sessions-port'
import { seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useStageStore } from '../../stage/store'

/**
 * **09-02 批 9d:FilesPanel 拆出来的那四件,各自一条守卫**。
 *
 * 面板整体的行为由 `files-panel.test.tsx`(68 例)从渲染层验 —— 那一份一个字
 * 没动,它本身就是这次拆分「等价」的最强证据。这一份验的是另一件事:**拆出来
 * 的四件各自站得住**,而且各配一条「拆掉即红」的反证(反证纪律)。
 */

/* ── 切线 A:useRowWindow —— 量测 + 切片 ────────────────────────────────── */

function WindowHarness({ rows }: { rows: readonly string[] }) {
  const { bodyRef, onScroll, shown, padTop, padBottom } = useRowWindow(rows)
  return (
    <div
      data-testid="win-body"
      ref={bodyRef}
      onScroll={onScroll}
      data-pad-top={padTop}
      data-pad-bottom={padBottom}
    >
      {shown.map((r) => (
        <div key={r} data-row={r} />
      ))}
    </div>
  )
}

const ROWS = Array.from({ length: 600 }, (_, i) => `row-${i}`)

describe('切线 A · useRowWindow:量测那一半出文件之后还是同一件事', () => {
  function mount() {
    render(<WindowHarness rows={ROWS} />)
    const body = screen.getByTestId('win-body')
    // jsdom 不排版,视口高度手动给 —— 量的是**窗口算术**,不是浏览器排版。
    Object.defineProperty(body, 'clientHeight', { value: 10 * FILES_ROW_H, configurable: true })
    return body
  }

  it('还没量到视口高度时交回**整表**(首帧画全量,不是画零行闪一记白)', () => {
    render(<WindowHarness rows={ROWS} />)
    expect(document.querySelectorAll('[data-row]').length).toBe(ROWS.length)
    expect(screen.getByTestId('win-body').getAttribute('data-pad-top')).toBe('0')
  })

  it('卷一下就同时读到 scrollTop 与 clientHeight:窗口收成「可视 + 上下缓冲」', async () => {
    const body = mount()
    await act(async () => {
      fireEvent.scroll(body, { target: { scrollTop: 0 } })
    })
    // 可视 10 行 +1 + 下缓冲 8 = 19(与 files-panel 那条整面用例同一个数)。
    expect(document.querySelectorAll('[data-row]').length).toBe(19)

    await act(async () => {
      fireEvent.scroll(body, { target: { scrollTop: 300 * FILES_ROW_H } })
    })
    expect(document.querySelectorAll('[data-row]').length).toBe(27)
    expect(document.querySelector('[data-row="row-0"]')).toBeNull()
    expect(document.querySelector('[data-row="row-300"]')).toBeTruthy()
  })

  it('两块空撑子把卷轴撑成整表那么长(padTop + 画出来的 + padBottom = 总高)', async () => {
    const body = mount()
    await act(async () => {
      fireEvent.scroll(body, { target: { scrollTop: 300 * FILES_ROW_H } })
    })
    const padTop = Number(body.getAttribute('data-pad-top'))
    const padBottom = Number(body.getAttribute('data-pad-bottom'))
    const drawn = document.querySelectorAll('[data-row]').length
    expect(padTop + drawn * FILES_ROW_H + padBottom).toBe(ROWS.length * FILES_ROW_H)
  })

  /*
   * 反证:把 `onScroll` 里那句补量(`setViewportH(clientHeight)`)拆掉,这一条红 ——
   * 那一句护的是「观察者还没回调而用户已经在卷」的那一帧(ResizeObserver 在 jsdom
   * 里根本不存在,所以这条用例跑的正是那一档降级)。
   */
  it('补量那一句是这里唯一的视口产地:没有它,卷到哪儿都还是整表', async () => {
    const body = mount()
    await act(async () => {
      fireEvent.scroll(body, { target: { scrollTop: 0 } })
    })
    expect(document.querySelectorAll('[data-row]').length).toBeLessThan(ROWS.length)
  })
})

/* ── 切线 C + D 合验:一行交出**行矩的 getter**,锚在面板旁边合成 ──────────────── */

const ROW: EntryRow = {
  kind: 'entry',
  path: '/w/a.ts',
  name: 'a.ts',
  type: 'file',
  depth: 0,
  expanded: false,
}

/**
 * 夹具照**面板那一侧的真接法**接:行交出行矩的 getter → `anchorBeside(面板, 行)`
 * 合成一块矩形(横向是面板两条边、纵向是那一行),`right-start` 落在面板旁边。
 *
 * 09-24 用户:「不要挡着文件 list」—— 从前右键锚光标、⋯ 锚行下,菜单一开就压住
 * 底下十几行。今天两条路交的是**同一只 getter**,所以落点只有一个;这一组守的
 * 就是「两条路同源」与「合成矩形的四条边各来自谁」。jsdom 量不出矩,所以给面板
 * 与行各 mock 一份 `getBoundingClientRect`。
 */
function rectOf(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect
}

function RowBesideHarness() {
  const t = useT()
  const [menu, setMenu] = useState<BesideAnchor | null>(null)
  const [current, setCurrent] = useState<HTMLElement | null>(null)
  const [detail, setDetail] = useState<BesideAnchor | null>(null)
  const panel = (): HTMLElement | null => document.querySelector('[data-testid="panel"]')
  return (
    <div data-testid="panel">
      <TreeEntryRow
        row={ROW}
        t={t}
        selected={false}
        openState={null}
        onActivate={() => undefined}
        onCurrent={(_row, el) => setCurrent(el)}
        onMenu={(rowRect) => setMenu(anchorBeside(panel, rowRect))}
      />
      <ButtonBase
        data-testid="keys-detail"
        onClick={() =>
          setDetail(anchorBeside(panel, () => current?.getBoundingClientRect() ?? null))
        }
      >
        detail-by-key
      </ButtonBase>
      <div data-testid="menu-at" data-rect={JSON.stringify(menu?.get() ?? null)} />
      <div data-testid="detail-at" data-rect={JSON.stringify(detail?.get() ?? null)} />
    </div>
  )
}

function rectAt(testId: string): Record<string, number> | null {
  return JSON.parse(screen.getByTestId(testId).getAttribute('data-rect') ?? 'null')
}

/** 面板 0–300、行 top 120 / bottom 147 —— 与 1200×800 真机上那一格同量级。 */
function mockRects() {
  const panel = screen.getByTestId('panel')
  panel.getBoundingClientRect = () => rectOf(0, 78, 300, 800)
  const wrap = document.querySelector('[data-file-path="/w/a.ts"]')!.parentElement as HTMLElement
  wrap.getBoundingClientRect = () => rectOf(8, 120, 292, 147)
  return wrap
}

describe('切线 C · TreeEntryRow:搬了家,三条回调一格不少', () => {
  function mount() {
    const onActivate = vi.fn()
    const onCurrent = vi.fn()
    const onMenu = vi.fn()
    function Harness() {
      const t = useT()
      return (
        <TreeEntryRow
          row={ROW}
          t={t}
          selected={false}
          openState={null}
          onActivate={onActivate}
          onCurrent={onCurrent}
          onMenu={onMenu}
        />
      )
    }
    render(<Harness />)
    const button = document.querySelector('[data-file-path="/w/a.ts"]') as HTMLElement
    return { onActivate, onCurrent, onMenu, button }
  }

  it('单击 = 打开(唯一的打开手势;双击那条路 09-01 已整条删掉)', () => {
    const { onActivate, button } = mount()
    fireEvent.click(button)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  /*
   * ── R2:这一行**不再自己接键** ─────────────────────────────────────────
   * ⌘I / ⌘↵ 的落点搬进了面板那一格作用域的 `keyHandlers`(声明在
   * `FOCUS_SCOPES.files.keys`),行只回答「当前是哪一行」。下面两条钉的正是
   * 这次搬家的两头:**键不在行上了**,而**报到还在**。
   */
  it('行上一条键都不接了:⌘I / ⌘↵ 原样冒上去(归面板那一格作用域)', () => {
    const { button } = mount()
    const i = fireEvent.keyDown(button, { key: 'i', metaKey: true })
    const enter = fireEvent.keyDown(button, { key: 'Enter', ctrlKey: true })
    // fireEvent 返回 true = 没人 preventDefault —— 这一行让开了。
    expect([i, enter]).toEqual([true, true])
  })

  it('焦点进 / 出这一行都报到:进的时候交外框,出的时候交 null', () => {
    const { onCurrent, button } = mount()
    fireEvent.focus(button)
    expect(onCurrent).toHaveBeenLastCalledWith(ROW, button.parentElement)
    fireEvent.blur(button)
    expect(onCurrent).toHaveBeenLastCalledWith(ROW, null)
  })
})

describe('切线 C+D · 行菜单开在面板旁边:两条路同一块锚,四条边各有出处', () => {
  it('右键 = 交行矩 getter:合成矩形横向是面板两条边、纵向是这一行', () => {
    render(<RowBesideHarness />)
    const wrap = mockRects()
    fireEvent.contextMenu(wrap, { clientX: 120, clientY: 200 })
    const r = rectAt('menu-at')!
    expect(r.left).toBe(0)
    expect(r.right).toBe(300)
    expect(r.top).toBe(120)
    expect(r.bottom).toBe(147)
  })

  it('行尾 ⋯ 与右键交的是**同一只 getter**:落点逐字相同,光标在哪儿无关', () => {
    render(<RowBesideHarness />)
    const wrap = mockRects()
    fireEvent.contextMenu(wrap, { clientX: 120, clientY: 200 })
    const byContext = rectAt('menu-at')
    fireEvent.click(screen.getByTestId('files-more:/w/a.ts'))
    expect(rectAt('menu-at')).toEqual(byContext)
  })

  it('⌘I 那条路(面板作用域按当前行开详情)同一块锚', () => {
    render(<RowBesideHarness />)
    mockRects()
    const button = document.querySelector('[data-file-path="/w/a.ts"]') as HTMLElement
    fireEvent.focus(button)
    fireEvent.click(screen.getByTestId('keys-detail'))
    const r = rectAt('detail-at')!
    expect([r.left, r.right, r.top, r.bottom]).toEqual([0, 300, 120, 147])
  })

  it('锚是活的:行矩变了,同一只 getter 读到新的行、面板不变', () => {
    render(<RowBesideHarness />)
    const wrap = mockRects()
    fireEvent.contextMenu(wrap, { clientX: 0, clientY: 0 })
    wrap.getBoundingClientRect = () => rectOf(8, 300, 292, 327)
    // 重新读一次 getter(组件里 data-rect 只在渲染时算,这里直接问锚本身)
    fireEvent.click(screen.getByTestId('files-more:/w/a.ts'))
    const r = rectAt('menu-at')!
    expect([r.top, r.bottom, r.left, r.right]).toEqual([300, 327, 0, 300])
  })

  it('面板或行还没挂上 → 锚答 null,首帧兜底落在 (0,0)', () => {
    const anchor = anchorBeside(() => null, () => null)
    expect(anchor.get()).toBeNull()
    expect(anchor.at).toEqual({ x: 0, y: 0 })
  })
})

const SESSION = 'os-provider'

describe('切线 B · NoWorkdirNotice:绑定的成败,以及律③的两半', () => {
  /**
   * 假端口的其余那几口。这一组走的是**产品那条真路**(组件 → store action →
   * `sessionMutation` → 端口),所以不 stub `setWorkingDirectory` —— 忙态那一格
   * 正是在这条路上记的账。除了 `updateWorkingDirectory`,别的口一律回一句
   * 「没接」:这一组一个都不问。
   */
  function installSessionsPort(updateWorkingDirectory: SessionsPort['updateWorkingDirectory']) {
    configureSessionsPort({
      ready: async () => undefined,
      listMeta: async () => ({ success: true, sessions: [] }),
      getSegments: async () => ({ success: true, segments: [] }),
      getMessagesPage: async () => ({ success: true, messages: [] }),
      getUserMarkers: async () => ({ success: true, markers: [] }),
      create: async () => ({ success: false, error: 'not stubbed' }),
      updateWorkingDirectory,
      updatePin: async () => ({ success: true }),
      rename: async () => ({ success: true }),
      delete: async () => ({ success: true }),
      onSessionEvent: () => () => undefined,
      onSessionLifecycle: () => () => undefined,
    })
  }

  /** 会话源那一口真动作。有用例会 setState 覆盖它,所以每条用例装回去。 */
  const REAL_SET_WORKDIR = useSessionsSource.getState().setWorkingDirectory

  beforeEach(() => {
    useStageStore.setState({ locale: 'zh' })
    useSessionsSource.setState({ setWorkingDirectory: REAL_SET_WORKDIR })
    sessionMutation.reset()
    seedSessionsSource()
  })

  function mountNotice() {
    function Harness() {
      const t = useT()
      return <NoWorkdirNotice sessionId={SESSION} t={t} />
    }
    render(<Harness />)
  }

  it('先是一条告知条;点「绑定…」才长出输入行,而且光标当场进去', async () => {
    mountNotice()
    expect(screen.getByTestId('files-no-workdir')).toBeTruthy()
    fireEvent.click(screen.getByText('绑定…'))
    const row = await screen.findByTestId('files-bind-row')
    expect(document.activeElement).toBe(row.querySelector('input'))
  })

  it('绑成功:输入行收起来,打的是 updateWorkingDirectory', async () => {
    const update = vi.fn(async () => ({ success: true }) as const)
    installSessionsPort(update)
    mountNotice()
    fireEvent.click(screen.getByText('绑定…'))
    const input = (await screen.findByTestId('files-bind-row')).querySelector('input')!
    fireEvent.change(input, { target: { value: '/w/here' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确定' }))
    })
    await waitFor(() => expect(update).toHaveBeenCalledWith(SESSION, '/w/here'))
    await waitFor(() => expect(screen.queryByTestId('files-bind-row')).toBeNull())
  })

  it('绑不上就**留在原地说**:输入行不收,后端原话跟在后面,那条路径还在', async () => {
    installSessionsPort(vi.fn(async () => ({ success: false, error: '不是一个目录' }) as const))
    mountNotice()
    fireEvent.click(screen.getByText('绑定…'))
    const input = (await screen.findByTestId('files-bind-row')).querySelector('input')!
    fireEvent.change(input, { target: { value: '/w/nope' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确定' }))
    })
    await waitFor(() => expect(screen.getByText('不是一个目录')).toBeTruthy())
    expect(screen.getByTestId('files-bind-row')).toBeTruthy()
    expect(input.value).toBe('/w/nope')
  })

  it('在飞时 aria-busy 立刻上、连点不发第二发(律③的一半:逐格,不是整面一颗)', async () => {
    let release: (() => void) | null = null
    const update = vi.fn(
      () =>
        new Promise<{ success: true }>((resolve) => {
          release = () => resolve({ success: true })
        }),
    )
    installSessionsPort(update)
    mountNotice()
    fireEvent.click(screen.getByText('绑定…'))
    const input = (await screen.findByTestId('files-bind-row')).querySelector('input')!
    fireEvent.change(input, { target: { value: '/w/slow' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确定' }))
    })
    const confirm = screen.getByRole('button', { name: '确定' })
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(confirm).toHaveProperty('disabled', true)
    // ↵ 也走同一条路(它不经过那颗钮),二次闸拦的正是这一下。
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(update).toHaveBeenCalledTimes(1)
    await act(async () => {
      release?.()
    })
  })

  /*
   * 律③的**另一半**(批 6 记的账,9d 结清):忙起来钮上要换字。它由
   * `ui/AsyncButton` 供给,并且**等 150ms 才换** —— 比这更快回来的请求根本不该
   * 报告自己在忙(E 型闪的判例)。反证:把 AsyncButton 换回 Button,这一条红。
   */
  it('忙满 150ms 之后钮上说「正在保存…」——换字走防闪闸,disabled 不等', () => {
    vi.useFakeTimers()
    try {
      installSessionsPort(vi.fn(() => new Promise<{ success: true }>(() => {})))
      mountNotice()
      fireEvent.click(screen.getByText('绑定…'))
      const input = screen.getByTestId('files-bind-row').querySelector('input')!
      fireEvent.change(input, { target: { value: '/w/slow' } })
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: '确定' }))
      })
      // 头 150ms 里只有灰与 aria-busy,字还没换(它挡的是连点,不是误读)。
      expect(screen.queryByText('正在保存…')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(screen.getByText('正在保存…')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('忙态是**那一条会话**那一格的账:别的会话在飞,这一颗一动不动', async () => {
    installSessionsPort(vi.fn(() => new Promise<{ success: true }>(() => {})))
    mountNotice()
    fireEvent.click(screen.getByText('绑定…'))
    const input = screen.getByTestId('files-bind-row').querySelector('input')!
    fireEvent.change(input, { target: { value: '/w/x' } })
    await act(async () => {
      void useSessionsSource.getState().setWorkingDirectory('lo-notes', '/elsewhere')
    })
    const confirm = screen.getByRole('button', { name: '确定' })
    expect(confirm.getAttribute('aria-busy')).toBeNull()
    expect(confirm).toHaveProperty('disabled', false)
  })
})

/* ── 拍点 1:单击留树,↵ 进查看器 ─────────────────────────────────────────── */

describe('切线 C · 打开手势:单击与 ↵ 的差别只有「焦点去哪」', () => {
  function mount() {
    const onActivate = vi.fn()
    function Harness() {
      const t = useT()
      return (
        <TreeEntryRow
          row={ROW}
          t={t}
          selected={false}
          openState={null}
          onActivate={onActivate}
          onCurrent={() => undefined}
          onMenu={() => undefined}
        />
      )
    }
    render(<Harness />)
    return { onActivate, button: document.querySelector('[data-file-path="/w/a.ts"]') as HTMLElement }
  }

  it('单击报 viaKeyboard=false(焦点留树,浏览器自己落在这颗钮上)', () => {
    const { onActivate, button } = mount()
    fireEvent.click(button)
    expect(onActivate).toHaveBeenCalledWith(false)
  })

  it('↵ 报 viaKeyboard=true,并且**挡掉那次合成 click**(不然开两遍)', () => {
    const { onActivate, button } = mount()
    const handled = fireEvent.keyDown(button, { key: 'Enter' })
    expect(onActivate).toHaveBeenCalledWith(true)
    expect(onActivate).toHaveBeenCalledTimes(1)
    // 反证:把那句 preventDefault 删掉 → 浏览器补一次 click,面板会开两遍
    // (目录那一行更明显:展开又收起)。
    expect(handled).toBe(false)
  })

  it('⌘↵ 不归这一行:它是面域局部键(详情),这一行一个字都不接', () => {
    const { onActivate, button } = mount()
    fireEvent.keyDown(button, { key: 'Enter', metaKey: true })
    expect(onActivate).not.toHaveBeenCalled()
  })
})
