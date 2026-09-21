import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { READOUT_TICK_MS, TailSlot } from '../TailSlot'
import { EXIT_MS } from '../../../components/motion'
import { configureComposerSink } from '../../../composer/sink'
import { useStageStore } from '../../../stage/store'

/**
 * **尾槽**的三张状态表(G 线 P1 立,P1b 裁定 B/C 改;正本
 * `apps/desktop-react/docs/stream-geometry-2026-09.md` §5.2 与 §8)。
 *
 * jsdom 证得了什么:**在跑时挂什么、收场那一段挂什么、点不动念不到的是哪一段、
 * 样式表里那一格的高是不是钉死的**。
 * 证不了什么:**高度真的没变**(jsdom 不排版)—— 那一半由真机门
 * `gate:stream-geometry` 量(首字帧尾槽位移 ≤1px、整轮贴底期间位移 ≤1px、
 * 收场淡出期间尾槽高度变化 0)。
 */

const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../TailSlot.module.css'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '')

const slot = () => screen.getByTestId('chat-tail-slot')

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  configureComposerSink(undefined)
  document.documentElement.removeAttribute('data-motion-tier')
})

describe('② UI 生命状态:空 / 在跑 / 收场中', () => {
  it('空:里面什么都不挂载,整格 inert + aria-hidden,**但它在**(高度照占)', () => {
    render(<TailSlot sessionId="s" running={false} />)
    expect(slot().getAttribute('data-face')).toBe('idle')
    expect(slot().hasAttribute('inert')).toBe(true)
    expect(slot().getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByTestId('chat-streaming')).toBeNull()
    // 读数那只 100ms 的表只在「在跑」时起 —— 空着时它连挂载都不该有。
    expect(screen.queryByTestId('chat-readout')).toBeNull()
  })

  /**
   * 裁定 B:**在跑的脸只有一张**。等待期与出字期是同一格东西 —— 光标 + 读数 + 停止,
   * 没有第二张脸、没有扫光那道线(`WaitingSeam` 随这一条删掉,全仓零消费者)。
   */
  it('在跑:光标 + 读数 + 停止,**没有第二张脸**', () => {
    render(<TailSlot sessionId="s" running startedAt={Date.now()} />)
    expect(slot().getAttribute('data-face')).toBe('run')
    expect(slot().hasAttribute('inert')).toBe(false)
    expect(screen.getByTestId('chat-streaming')).toBeTruthy()
    expect(screen.getByTestId('chat-readout')).toBeTruthy()
    expect(screen.getByTestId('chat-stop')).toBeTruthy()
    expect(screen.queryByTestId('waiting-seam')).toBeNull()
    // 一张脸 = 一个光标节点。两个就是又长回两张脸了。
    expect(screen.getAllByTestId('chat-streaming')).toHaveLength(1)
  })

  /**
   * 裁定 B 的正面断言:**等待期与出字期是同一棵树**。
   *
   * 比的是**结构**不是那行字 —— 读数本来就该跟着秒数变(它是「寿命读数」,
   * 见 `StreamReadout` 的「动效档」那一节)。所以这里钉三件:那一格的相位没变、
   * 指示格那一枝逐字相同、光标与停止钮都是同一个 DOM 节点(= 没有换手、没有重挂)。
   */
  it('等待期与出字期**是同一棵树** —— 这一格不认识「还没出字」这件事', () => {
    const start = Date.now()
    const view = render(<TailSlot sessionId="s" running startedAt={start} />)
    const indicatorBefore = slot().firstElementChild!.firstElementChild!.outerHTML
    const cursorBefore = screen.getByTestId('chat-streaming')
    const stopBefore = screen.getByTestId('chat-stop')
    // 出字了:在这一格眼里什么都没发生(它只知道「在跑」)。
    view.rerender(<TailSlot sessionId="s" running startedAt={start} lastActivityAt={start + 500} />)
    expect(slot().getAttribute('data-face')).toBe('run')
    expect(slot().firstElementChild!.firstElementChild!.outerHTML).toBe(indicatorBefore)
    expect(screen.getByTestId('chat-streaming')).toBe(cursorBefore)
    expect(screen.getByTestId('chat-stop')).toBe(stopBefore)
  })

  /**
   * 重试那段真空:账本上还没有这一轮的助手消息,「跑了多久」无从说起 ——
   * 那时只画那枚光标,不画一个编出来的读数。
   */
  it('没有起点:画光标不画读数(不编一个出来)', () => {
    render(<TailSlot sessionId="s" running />)
    expect(screen.getByTestId('chat-streaming')).toBeTruthy()
    expect(screen.queryByTestId('chat-readout')).toBeNull()
  })
})

describe('② 收场:先淡出,播完才卸载(裁定 C)', () => {
  it('收场那一刻内容还在、整格已经 inert,读数**冻住**', () => {
    vi.useFakeTimers()
    try {
      const start = Date.now()
      const view = render(
        <TailSlot sessionId="s" running startedAt={start} lastActivityAt={start} />,
      )
      act(() => {
        vi.advanceTimersByTime(3_000)
      })
      const frozen = screen.getByTestId('chat-readout').textContent
      // run 收场:`ChatStream` 那一侧 startedAt 当场变 undefined,这一件自己留着上一份。
      view.rerender(<TailSlot sessionId="s" running={false} />)
      expect(slot().getAttribute('data-face')).toBe('leaving')
      expect(screen.getByTestId('chat-streaming')).toBeTruthy()
      // 还在屏上,但已经不作数了:Tab 与读屏都碰不到那颗停止钮。
      expect(slot().hasAttribute('inert')).toBe(true)
      expect(slot().getAttribute('aria-hidden')).toBe('true')
      /*
       * 表停了:再走一个读数节拍(100ms)那行字一个字符都不变 —— 表还走着的话
       * 这一拍就会把它刷成下一个十分之一秒。走的这一段要**短于淡出那一段**,
       * 不然断言的就成了「卸载之后没有读数」那件别的事。
       */
      act(() => {
        vi.advanceTimersByTime(READOUT_TICK_MS + 10)
      })
      expect(EXIT_MS).toBeGreaterThan(READOUT_TICK_MS)
      expect(screen.getByTestId('chat-readout').textContent).toBe(frozen)
    } finally {
      vi.useRealTimers()
    }
  })

  it('播完就卸载 —— 那一格回到空,但格子还在', () => {
    vi.useFakeTimers()
    try {
      const view = render(<TailSlot sessionId="s" running startedAt={Date.now()} />)
      view.rerender(<TailSlot sessionId="s" running={false} />)
      act(() => {
        vi.advanceTimersByTime(EXIT_MS + 10)
      })
      expect(slot().getAttribute('data-face')).toBe('idle')
      expect(screen.queryByTestId('chat-streaming')).toBeNull()
      expect(screen.queryByTestId('chat-readout')).toBeNull()
      expect(slot()).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('淡出播到一半又开了新一轮:**直接回到在跑那张脸**,不经过空态', () => {
    vi.useFakeTimers()
    try {
      const view = render(<TailSlot sessionId="s" running startedAt={1_000} />)
      const cursorBefore = screen.getByTestId('chat-streaming')
      view.rerender(<TailSlot sessionId="s" running={false} />)
      act(() => {
        vi.advanceTimersByTime(Math.floor(EXIT_MS / 2))
      })
      expect(slot().getAttribute('data-face')).toBe('leaving')
      view.rerender(<TailSlot sessionId="s" running startedAt={2_000} />)
      expect(slot().getAttribute('data-face')).toBe('run')
      expect(slot().hasAttribute('inert')).toBe(false)
      // 没有重挂:同一个 DOM 节点,所以不会闪一下。
      expect(screen.getByTestId('chat-streaming')).toBe(cursorBefore)
      // 那一发旧的定时器不许把新的一轮掐掉。
      act(() => {
        vi.advanceTimersByTime(EXIT_MS * 2)
      })
      expect(slot().getAttribute('data-face')).toBe('run')
    } finally {
      vi.useRealTimers()
    }
  })

  it('动效档「无」:没有淡出这一段,当场卸载', () => {
    vi.useFakeTimers()
    try {
      document.documentElement.setAttribute('data-motion-tier', 'none')
      const view = render(<TailSlot sessionId="s" running startedAt={Date.now()} />)
      view.rerender(<TailSlot sessionId="s" running={false} />)
      expect(slot().getAttribute('data-face')).toBe('idle')
      expect(screen.queryByTestId('chat-streaming')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('挂载时就不在跑的那一次**不播**淡出(否则每片叶开屏先播一段没人要的)', () => {
    render(<TailSlot sessionId="s" running={false} />)
    expect(slot().getAttribute('data-face')).toBe('idle')
  })
})

describe('③ 交互状态:停止打给的是这一格自己那条会话', () => {
  it('停止走 composerSink().abort(sessionId) —— 分屏下停不到隔壁去', () => {
    const stopped: string[] = []
    configureComposerSink({
      send: () => true,
      notice: () => undefined,
      abort: (id) => {
        stopped.push(id ?? '')
      },
      startSession: async () => undefined,
    })
    render(<TailSlot sessionId="leaf-b" running startedAt={Date.now()} />)
    fireEvent.click(screen.getByTestId('chat-stop'))
    expect(stopped).toEqual(['leaf-b'])
  })
})

/**
 * ── 样式表那一格:**高度钉死**是这一整件事的地基 ───────────────────────────
 * 「从开张到收场几何上什么都不发生」靠的是那一格 `block-size`,不是里面恰好一样高。
 * 反证口:把 `block-size` 换成 `min-block-size`,读数行进出时这一格的高就又跟着
 * 内容走了,真机门的「收场淡出期间尾槽高度变化 0」当场红。
 */
describe('样式表:那一格的高与里面此刻有没有东西无关', () => {
  it('高度取自 token,不是排出来的', () => {
    expect(css).toMatch(/\.slot\s*\{[^}]*block-size:\s*var\(--tail-slot-h\)/)
    expect(css).not.toMatch(/\.slot\s*\{[^}]*min-block-size/)
  })

  it('淡出只改 opacity,**不**从布局里摘掉、也不碰那一格的高', () => {
    const rule = /\.body\[data-leaving\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/opacity:\s*0/)
    expect(rule).toMatch(/transition:\s*opacity var\(--dur-exit\)/)
    expect(rule).not.toMatch(/display\s*:/)
    expect(rule).not.toMatch(/visibility\s*:/)
    expect(rule).not.toMatch(/block-size|height/)
  })

  /**
   * 「淡出播到一半又开了新一轮就直接回去」的 CSS 那一半:过渡**只**声明在淡出那一态上。
   * 写在 `.body` 上就成了双向过渡,回去那一下变成一段反向动画。
   */
  it('过渡只长在淡出那一态上,`.body` 自己不带 transition', () => {
    const base = /\.body\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(base).not.toMatch(/transition/)
    expect(base).not.toMatch(/opacity/)
  })

  /** 两张脸那一套(grid 叠格 + `data-on`)随裁定 B 一起退役,不许长回来。 */
  it('两张脸那一套已经没有了', () => {
    expect(css).not.toMatch(/grid-area/)
    expect(css).not.toMatch(/data-on/)
  })

  /** 光标是**逐字搬**过来的(`ChatStream.module.css` 的 `.cursor`):两档降级一并搬。 */
  it('两档降级都在(动效档「无」与系统 reduced-motion),淡出也跟着摊平', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toMatch(/:root\[data-motion-tier='none'\] \.cursor/)
    expect(css).toMatch(/:root\[data-motion-tier='none'\] \.body\[data-leaving\]/)
  })
})
