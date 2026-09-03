import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useT } from '../../i18n'
import { FILES_ROW_H } from '../../data/files-source'
import { ButtonBase } from '../../ui/ButtonBase'
import { anchorBelow, useFileFloats } from '../file-floats'
import { DETAIL_POPOVER_GAP } from '../FileDetailPopover'
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

/* ── 切线 C + D 合验:一行交出**来源**,锚点算式只跑一遍 ──────────────────── */

const ROW: EntryRow = {
  kind: 'entry',
  path: '/w/a.ts',
  name: 'a.ts',
  type: 'file',
  depth: 0,
  expanded: false,
}

/**
 * 夹具照**面板那一侧的真接法**接:行交出来源 → `useFileFloats` 算锚点。
 *
 * 这一层是刻意的:批 9d 的真机前后对照量出过一处 4px 漂移 —— 行上先
 * `anchorBelow(rect)` 算一遍、`openDetailAt` 又算一遍,浮层多隔了一条缝。
 * 只断言「onMenu 被调用了」是抓不到那种事的,**得断言最后那一点落在哪儿**。
 */
function RowFloatsHarness({ detailFromMenu = false }: { detailFromMenu?: boolean }) {
  const t = useT()
  const { menuAt, detailAt, openMenuAt, openDetailAt } = useFileFloats()
  /*
   * ── R2:⌘I 的落点搬到了**面板那一格作用域**上 ────────────────────────────
   * 行不再自己接键,它只**报到**(`onCurrent`)。所以这只夹具照面板那一处的样子
   * 记一格「当前是哪一行、它的外框是谁」,再由下面那颗 `keys-detail` 钮代替
   * `keyHandlers.detail` 按下去 —— 锚点算式(交出去的是**来源**不是坐标)
   * 一个字没动,这一组守的正是那件事。
   */
  const [current, setCurrent] = useState<HTMLElement | null>(null)
  return (
    <div>
      <TreeEntryRow
        row={ROW}
        t={t}
        selected={false}
        opened={false}
        onActivate={() => undefined}
        onCurrent={(_row, el) => setCurrent(el)}
        onMenu={openMenuAt}
      />
      <ButtonBase
        data-testid="keys-detail"
        onClick={() => openDetailAt(current?.getBoundingClientRect())}
      >
        detail-by-key
      </ButtonBase>
      {/* 从菜单里开详情那一路(树面传 gap:false —— 菜单自己已经隔过一条缝了)。 */}
      {detailFromMenu && menuAt && (
        <ButtonBase
          data-testid="menu-detail"
          onClick={() => openDetailAt(menuAt, { gap: false })}
        >
          detail
        </ButtonBase>
      )}
      <div
        data-testid="menu-at"
        data-x={menuAt?.x ?? ''}
        data-y={menuAt?.y ?? ''}
      />
      <div
        data-testid="detail-at"
        data-x={detailAt?.x ?? ''}
        data-y={detailAt?.y ?? ''}
      />
    </div>
  )
}

function at(testId: string): { x: string; y: string } {
  const el = screen.getByTestId(testId)
  return { x: el.getAttribute('data-x') ?? '', y: el.getAttribute('data-y') ?? '' }
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
          opened={false}
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

describe('切线 C+D · 锚点只算一遍:一行交的是**来源**,不是算好的坐标', () => {
  it('右键 = 点锚:菜单就落在光标那一点上,一条缝都不加', () => {
    render(<RowFloatsHarness />)
    const wrap = document.querySelector('[data-file-path="/w/a.ts"]')!.parentElement!
    fireEvent.contextMenu(wrap, { clientX: 120, clientY: 200 })
    expect(at('menu-at')).toEqual({ x: '120', y: '200' })
  })

  /*
   * 反证(这一条是那 4px 漂移的守卫):把行上那句改回「先自己 anchorBelow 一遍
   * 再交出去」,菜单会落在 204 —— 真机前后对照量到的正是这个数。
   */
  it('行尾 ⋯ = 矩锚:贴着行矩左下角**只隔一条缝**(不是两条)', () => {
    render(<RowFloatsHarness />)
    fireEvent.click(screen.getByTestId('files-more:/w/a.ts'))
    // jsdom 量不出矩(全 0),所以读数是「取不到矩」那一档:(0, GAP)——
    // 与迁移前 `rect?.left ?? 0` / `(rect?.bottom ?? 0) + GAP` 逐字相同。
    expect(at('menu-at')).toEqual({ x: '0', y: String(DETAIL_POPOVER_GAP) })
  })

  it('⌘I = 矩锚:详情同样只隔一条缝(R2:落点在面板,来源仍是那一行的外框)', () => {
    render(<RowFloatsHarness />)
    const button = document.querySelector('[data-file-path="/w/a.ts"]') as HTMLElement
    fireEvent.focus(button)
    fireEvent.click(screen.getByTestId('keys-detail'))
    expect(at('detail-at')).toEqual({ x: '0', y: String(DETAIL_POPOVER_GAP) })
  })

  it('从菜单里开详情:**落在菜单那一点上**(gap:false —— 树面那一档,零缝)', () => {
    render(<RowFloatsHarness detailFromMenu />)
    const wrap = document.querySelector('[data-file-path="/w/a.ts"]')!.parentElement!
    fireEvent.contextMenu(wrap, { clientX: 120, clientY: 200 })
    fireEvent.click(screen.getByTestId('menu-detail'))
    expect(at('detail-at')).toEqual(at('menu-at'))
    expect(at('detail-at')).toEqual({ x: '120', y: '200' })
  })

  it('缺省那一档仍然隔一条缝 —— 查看器那一面一个字节没动', () => {
    render(<RowFloatsHarness />)
    const wrap = document.querySelector('[data-file-path="/w/a.ts"]')!.parentElement!
    fireEvent.contextMenu(wrap, { clientX: 120, clientY: 200 })
    // 同一个点走缺省档:比点锚低一条缝(那正是查看器右键→详情的算法)。
    expect(anchorBelow({ x: 120, y: 200 })).toEqual({ x: 120, y: 200 + DETAIL_POPOVER_GAP })
  })

  it('gap 是一格**长度**不是布尔:传 0 与不传的差恰好是那一条缝', () => {
    expect(anchorBelow({ x: 5, y: 7 }, 0)).toEqual({ x: 5, y: 7 })
    expect(anchorBelow({ x: 5, y: 7 })).toEqual({ x: 5, y: 7 + DETAIL_POPOVER_GAP })
    // 取不到锚时也照这条规矩:0 缝落在原点,缺省落在一条缝下面。
    expect(anchorBelow(null, 0)).toEqual({ x: 0, y: 0 })
    expect(anchorBelow(null)).toEqual({ x: 0, y: DETAIL_POPOVER_GAP })
  })
})

/* ── 切线 B:NoWorkdirNotice —— 绑定成败与律③两半 ──────────────────────── */

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
          opened={false}
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
