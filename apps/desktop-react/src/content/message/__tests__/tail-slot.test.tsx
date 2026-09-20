import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TailSlot } from '../TailSlot'
import { configureComposerSink } from '../../../composer/sink'
import { useStageStore } from '../../../stage/store'

/**
 * **尾槽**的三张状态表(G 线 P1,正本 `apps/desktop-react/docs/stream-geometry-2026-09.md`
 * §5.2)。
 *
 * jsdom 证得了什么:**哪张脸亮着、读数与停止在不在、暗的那张点不动念不到、
 * 样式表里那一格的高是不是钉死的**。
 * 证不了什么:**高度真的没变**(jsdom 不排版)—— 那一半由真机门
 * `gate:stream-geometry` 量(首字帧尾槽位移 ≤1px、整轮贴底期间位移 ≤1px、
 * 收尾帧改动点以上位移 ≤1px)。
 */

const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../TailSlot.module.css'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '')

const slot = () => screen.getByTestId('chat-tail-slot')

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  configureComposerSink(undefined)
})

describe('② UI 生命状态:空 / 等待 / 流式', () => {
  it('空:两张脸都不挂载,整格 inert + aria-hidden,**但它在**(高度照占)', () => {
    render(<TailSlot sessionId="s" face="idle" />)
    expect(slot().getAttribute('data-face')).toBe('idle')
    expect(slot().hasAttribute('inert')).toBe(true)
    expect(slot().getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByTestId('waiting-seam')).toBeNull()
    expect(screen.queryByTestId('chat-streaming')).toBeNull()
    // 读数那只 100ms 的表只在「在跑」时起 —— 空着时它连挂载都不该有。
    expect(screen.queryByTestId('chat-readout')).toBeNull()
  })

  it('等待:在扫的线亮着,光标那张在同一格里暗着', () => {
    render(<TailSlot sessionId="s" face="wait" startedAt={Date.now()} />)
    expect(slot().getAttribute('data-face')).toBe('wait')
    expect(screen.getByTestId('waiting-seam').closest('[data-on]')).toBeTruthy()
    expect(screen.getByTestId('chat-streaming').closest('[data-on]')).toBeNull()
    expect(screen.getByTestId('chat-readout')).toBeTruthy()
    expect(screen.getByTestId('chat-stop')).toBeTruthy()
  })

  it('流式:光标亮着,在扫的线暗着 —— 换的只有那一格 data-on', () => {
    render(<TailSlot sessionId="s" face="stream" startedAt={Date.now()} />)
    expect(slot().getAttribute('data-face')).toBe('stream')
    expect(screen.getByTestId('chat-streaming').closest('[data-on]')).toBeTruthy()
    expect(screen.getByTestId('waiting-seam').closest('[data-on]')).toBeNull()
  })

  it('换手:两张脸**都不重挂** —— 同一个 DOM 节点,只换 data-on', () => {
    const view = render(<TailSlot sessionId="s" face="wait" startedAt={Date.now()} />)
    const seamBefore = screen.getByTestId('waiting-seam')
    const cursorBefore = screen.getByTestId('chat-streaming')
    view.rerender(<TailSlot sessionId="s" face="stream" startedAt={Date.now()} />)
    expect(screen.getByTestId('waiting-seam')).toBe(seamBefore)
    expect(screen.getByTestId('chat-streaming')).toBe(cursorBefore)
  })

  /**
   * 暗的那张 `inert`:一张看不见的脸还能接焦点比没有焦点更糟
   * (判词与 `MessageChrome` 那一节逐字同源)。
   */
  it('暗的那张 inert —— Tab 走不到、读屏念不到', () => {
    render(<TailSlot sessionId="s" face="stream" startedAt={Date.now()} />)
    expect(screen.getByTestId('waiting-seam').closest('[inert]')).toBeTruthy()
    expect(screen.getByTestId('chat-streaming').closest('[inert]')).toBeNull()
  })

  /**
   * 重试那段真空:账本上还没有这一轮的助手消息,「跑了多久」无从说起 ——
   * 那时只画在扫的线,不画一个编出来的读数。
   */
  it('没有起点:画线不画读数(不编一个出来)', () => {
    render(<TailSlot sessionId="s" face="wait" />)
    expect(screen.getByTestId('waiting-seam')).toBeTruthy()
    expect(screen.queryByTestId('chat-readout')).toBeNull()
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
    render(<TailSlot sessionId="leaf-b" face="stream" startedAt={Date.now()} />)
    fireEvent.click(screen.getByTestId('chat-stop'))
    expect(stopped).toEqual(['leaf-b'])
  })
})

/**
 * ── 样式表那一格:**高度钉死**是这一整件事的地基 ───────────────────────────
 * 「三张脸同格同高」在这里不是靠两张脸恰好一样高 —— 是靠那一格 `block-size`。
 * 反证口:把 `block-size` 换成 `min-block-size`,读数行进出时这一格的高就又跟着
 * 内容走了,真机门的「收尾帧改动点以上位移 ≤1px」当场红。
 */
describe('样式表:那一格的高与此刻是哪张脸无关', () => {
  it('高度取自 token,不是排出来的', () => {
    expect(css).toMatch(/\.slot\s*\{[^}]*block-size:\s*var\(--tail-slot-h\)/)
    expect(css).not.toMatch(/\.slot\s*\{[^}]*min-block-size/)
  })

  it('两张脸落在同一格(grid-area 1 / 1),换脸只换 opacity', () => {
    expect(css).toMatch(/\.indicator\s*\{[^}]*display:\s*grid/)
    expect(css).toMatch(/\.face\s*\{[^}]*grid-area:\s*1\s*\/\s*1/)
    expect(css).toMatch(/\.face\s*\{[^}]*transition:\s*opacity var\(--dur-flash\)/)
  })

  it('暗的那张只降透明度,**不**从布局里摘掉', () => {
    const rule = /\.face:not\(\[data-on\]\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/opacity:\s*0/)
    expect(rule).not.toMatch(/display\s*:/)
    expect(rule).not.toMatch(/visibility\s*:/)
  })

  /** 光标是**逐字搬**过来的(`ChatStream.module.css` 的 `.cursor`):两档降级一并搬。 */
  it('光标的两档降级一起搬过来了(动效档「无」与系统 reduced-motion)', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toMatch(/:root\[data-motion-tier='none'\] \.cursor/)
  })
})
