import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { ChatStream } from '../ChatStream'
import { configureChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'

/**
 * **重试:按下即开槽**(单 B ⑥,正本 `docs/send-flow-2026-09.md` §2 规矩 ⑥)。
 *
 * 值得进 jsdom 的是**那段真空里屏幕上有没有回音**:`retryPending` 一在场,
 * 折痕当场在扫、旧回答当场挂上上折那一格 —— 两件都在**同一次提交**里,不等账本
 * 把旧回复删掉。「折得顺不顺、气泡动没动」是几何,由真机门量
 * (`gate:send-flow` ⑥:折痕在按下后 ≤100ms 就在扫、只滑过一段、落位回到视口里)。
 */

const T0 = 1_700_000_000_000
const SESSION = 'retry-slot'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const LEDGER: Ledger[] = [
  { seq: 1, time: T0, type: 'session/created', data: { sessionId: SESSION } },
  {
    seq: 2,
    time: T0,
    type: 'user/message',
    data: { message: { id: 'm1', role: 'user', content: '你好', timestamp: T0 } },
  },
  {
    seq: 3,
    time: T0,
    type: 'run/start',
    data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 },
  },
  {
    seq: 4,
    time: T0,
    type: 'assistant/chunks',
    data: {
      runId: 'r1',
      requestIndex: 0,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: T0,
      dt: [0],
      text: ['好的'],
    },
  },
  { seq: 5, time: T0, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
]

const source = () => chatSources.ensure(SESSION)

async function mount() {
  configureChatPort({
    ready: async () => undefined,
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: [...LEDGER] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
  })
  useExposeStore.setState({ currentSessionId: SESSION })
  const view = await act(async () => render(<ChatStream sessionId={SESSION} />))
  await waitFor(() => expect(source().getState().status).not.toBe('loading'))
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  source().getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
})

afterEach(async () => {
  await act(async () => {
    source().getState().reset()
  })
  configureChatPort(undefined)
})

describe('按下即开槽', () => {
  it('按下之前:没有折痕,旧回答也没在折', async () => {
    const { container } = await mount()
    expect(screen.queryByTestId('waiting-seam')).toBeNull()
    expect(container.querySelector('[data-message-id="a1"]')?.className).not.toMatch(/Retiring/)
  })

  it('`retryPending` 一在场:折痕当场在扫,旧回答当场开始上折', async () => {
    const { container } = await mount()
    await act(async () => {
      source().getState().regenerate('a1')
    })
    // 账本一个字都还没变 —— 这正是那段真空。
    expect(source().getState().retryPending?.messageId).toBe('a1')
    const seam = screen.getByTestId('waiting-seam')
    expect(seam.getAttribute('data-state')).toBe('running')
    const row = container.querySelector('[data-message-id="a1"]')
    expect(row?.className).toMatch(/Retiring/)
  })

  /**
   * **折痕不许画在正在上折的那一行里**(09-15 改判,第一版就是那么写的):那一行此刻挂着
   * `.rowRetiring`(`height: 0` + `overflow: clip` + `opacity: 0`),画在里面的东西跟着一起
   * 折没了 —— jsdom 不算样式、真机门只问「折痕在不在树上」,两边都会放它过去,可屏幕上
   * 一道折痕都看不见。它自己一行,排在那一行**后面**(新一轮的回答就从那儿起)。
   */
  it('折痕自己一行,排在正在上折的那一条**后面**,不在它里面', async () => {
    const { container } = await mount()
    await act(async () => {
      source().getState().regenerate('a1')
    })
    const retiring = container.querySelector('[data-message-id="a1"]')
    expect(retiring?.querySelector('[data-testid="waiting-seam"]')).toBeNull()
    const seamRow = container.querySelector('[data-retry-of="a1"]')
    expect(seamRow?.querySelector('[data-testid="waiting-seam"]')).toBeTruthy()
    expect(retiring?.nextElementSibling).toBe(seamRow)
    // 它不是一条消息 —— TOC / locate-message 的取件口只认 `data-message-id`。
    expect(seamRow?.hasAttribute('data-message-id')).toBe(false)
  })
})

describe('源文本:上折是高度过渡,落位排在「那一发回来了」那一拍', () => {
  const src = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ChatStream.tsx'),
    'utf-8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  const css = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ChatStream.module.css'),
    'utf-8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')

  it('`.rowRetiring` 走 --dur-card-flip 的高度过渡(不是直接卸载)', () => {
    const rule = /\.rowRetiring\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/interpolate-size:\s*allow-keywords/)
    expect(rule).toMatch(/height:\s*0/)
    expect(rule).toMatch(/transition:[\s\S]*height var\(--dur-card-flip\)/)
  })

  /**
   * 反证口:把 `was === undefined || retryingId !== undefined` 那一句换成
   * 「按下那一拍就落位」,真机门 ⑥ 的落点当场红 —— 按下那一拍旧回答才刚开始上折,
   * 算出来的置顶线是按旧高度算的,而接下来 180ms 它一路缩到 0(实测停在 471 而不是 24)。
   */
  it('落位排在 `retryPending` **清闩**那一拍,不是按下那一拍', () => {
    const effect = /const seenRetryRef = useRef\(retryingId\)([\s\S]*?)\}, \[retryingId, landOnRetry\]\)/
      .exec(src)?.[1] ?? ''
    expect(effect).not.toBe('')
    expect(effect).toMatch(/if \(was === undefined \|\| retryingId !== undefined\) return/)
    expect(effect).toMatch(/landOnRetry\(\)/)
  })

  it('气泡已经在视口里就不滑(规矩 ⑥ 的字面)', () => {
    const fn = /const landOnRetry = useCallback\(([\s\S]*?)\n {2}\}, \[/.exec(src)?.[1] ?? ''
    expect(fn).not.toBe('')
    expect(fn).toMatch(/if \(rect\.top >= view\.top && rect\.bottom <= view\.bottom\) return/)
  })

  it('发送与重试落到置顶线走的是**同一段插值**(一个产地)', () => {
    expect([...src.matchAll(/const slideScrollTo = useCallback/g)]).toHaveLength(1)
    expect([...src.matchAll(/slideScrollTo\(el, target\)/g)]).toHaveLength(2)
  })
})
