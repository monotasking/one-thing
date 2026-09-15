import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageChrome } from '../MessageChrome'

/**
 * **三张脸同格同高**(单 B ⑤,正本 `docs/send-flow-2026-09.md` §2 规矩 ⑤)。
 *
 * 值得进 jsdom 的只有**结构**:两张脸在不在同一格、暗的那张点不动念不到、
 * 样式表里那一格是不是 grid。**高度相等是排版**,jsdom 不排版 —— 那一半由真机门
 * 量(`gate:send-flow` 的 ②b:换手之后气泡全程不动,最远 ≤ 1px;单 B ⑤ 之前
 * 那里是 12.0px 一帧)。
 */

const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../MessageChrome.module.css'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '')

describe('两张脸,一格', () => {
  it('流式中:读数在前,动作那张在场但 inert', () => {
    render(
      <MessageChrome streaming readout={<div data-testid="r" />} actions={<div data-testid="a" />} />,
    )
    expect(screen.getByTestId('chat-chrome').getAttribute('data-face')).toBe('readout')
    expect(screen.getByTestId('r').closest('[inert]')).toBeNull()
    expect(screen.getByTestId('a').closest('[inert]')).toBeTruthy()
  })

  it('收尾后:动作在前,读数那张由调用方卸掉(它带着一只 100ms 的表)', () => {
    render(<MessageChrome streaming={false} actions={<div data-testid="a" />} />)
    expect(screen.getByTestId('chat-chrome').getAttribute('data-face')).toBe('actions')
    expect(screen.getByTestId('a').closest('[inert]')).toBeNull()
  })

  it('一张脸都没有就整件不画 —— 不留一个空盒子占位', () => {
    const { container } = render(<MessageChrome streaming={false} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('样式表:同格同高是一格 grid,不是条件渲染', () => {
  it('.chrome 是 grid,.face 全落在同一格', () => {
    expect(css).toMatch(/\.chrome\s*\{[^}]*display:\s*grid/)
    expect(css).toMatch(/\.face\s*\{[^}]*grid-area:\s*1\s*\/\s*1/)
  })

  /**
   * 反证口:把这一条换成 `display: none` / `visibility: hidden`,那一格的高就又
   * 跟着「此刻是哪张脸」变了 —— 那正是要治的病(真机 ②b 当场从 0 回到 12px)。
   */
  it('暗的那张只降透明度,**不**从布局里摘掉', () => {
    const rule = /\.face:not\(\[data-on\]\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/opacity:\s*0/)
    expect(rule).not.toMatch(/display\s*:/)
    expect(rule).not.toMatch(/visibility\s*:/)
  })

  it('换脸走 --dur-flash(§2 规矩 ⑤ 的「交叉淡入」)', () => {
    expect(css).toMatch(/\.face\s*\{[^}]*transition:\s*opacity var\(--dur-flash\)/)
  })
})
