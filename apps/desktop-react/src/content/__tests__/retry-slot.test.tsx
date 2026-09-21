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
  it('按下之前:尾槽空着,旧回答也没在折', async () => {
    const { container } = await mount()
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('idle')
    expect(screen.queryByTestId('chat-streaming')).toBeNull()
    expect(container.querySelector('[data-message-id="a1"]')?.className).not.toMatch(/Retiring/)
  })

  /**
   * 「回音」这件事 2026-09-21 换了形(P1b 裁定 B):从前是一道在扫的线
   * (`WaitingSeam`,那一件已删),今天是尾槽**整格翻成在跑的样子** —— 呼吸光标
   * 在那儿。等待期与出字期一模一样,正是用户要的「流式过程中这块样式布局保持不变」。
   */
  it('`retryPending` 一在场:尾槽当场翻成在跑,旧回答当场开始上折', async () => {
    const { container } = await mount()
    await act(async () => {
      source().getState().regenerate('a1')
    })
    // 账本一个字都还没变 —— 这正是那段真空。
    expect(source().getState().retryPending?.messageId).toBe('a1')
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('run')
    expect(screen.getByTestId('chat-streaming')).toBeTruthy()
    const row = container.querySelector('[data-message-id="a1"]')
    expect(row?.className).toMatch(/Retiring/)
  })

  /**
   * ── 折痕住哪儿:**2026-09-20 G 线 P1 改判**(第二次改判)──────────────────
   *
   * 09-15 那一版:折痕**自己一行**(`article[data-retry-of]`),排在正在上折的那条
   * **后面** —— 起因是更早那一版把它画在正在上折的那一行**里面**,而那一行此刻挂着
   * `.rowRetiring`(`height: 0` + `overflow: clip` + `opacity: 0`),画进去屏幕上一道
   * 折痕都看不见。
   *
   * 今天:**它谁的行里都不在**,它住在整列末尾那一格尾槽里(正本
   * `docs/stream-geometry-2026-09.md` §2 拍点 2「等待指示只留一处:尾部」)。
   * 那一行 `data-retry-of` 连同 `retrySeamRow` 一起退役 —— 它是一行**事后插进列里**
   * 的行,插与拔各推一次下文,正是 §1 的 G4 要拆掉的那一种。
   *
   * 旧断言因此这样迁:「不在正在上折的那一行里」原样留着(今天更强:它也不在别的
   * 任何一条消息里),「排在它后面的那一行里有」换成「在尾槽里」。
   * 2026-09-21 再迁一次:那道折痕本身删了,取件口从 `waiting-seam` 换成那枚光标
   * (`chat-streaming`)—— **住哪儿**这件事一个字没变。
   */
  it('回音住在列尾那一格尾槽里,不在任何一条消息行里', async () => {
    const { container } = await mount()
    await act(async () => {
      source().getState().regenerate('a1')
    })
    const retiring = container.querySelector('[data-message-id="a1"]')
    expect(retiring?.querySelector('[data-testid="chat-streaming"]')).toBeNull()
    const cursor = screen.getByTestId('chat-streaming')
    expect(cursor.closest('[data-message-id]')).toBeNull()
    expect(cursor.closest('[data-tail-slot]')).toBeTruthy()
    // 那一行 `data-retry-of` 退役了:同一句话不许在屏幕上说两遍。
    expect(container.querySelector('[data-retry-of]')).toBeNull()
    // `WaitingSeam` 整件退役(P1b 裁定 B):全仓零消费者。
    expect(screen.queryByTestId('waiting-seam')).toBeNull()
  })

  /**
   * 重试那段真空里**账本上没有这一轮的助手消息**,所以「跑了多久」无从说起 ——
   * 那时只画那枚光标,不画一个编出来的读数(判词在 `TailSlot` 的 `startedAt` 上)。
   */
  it('真空里不画读数:没有起点就不编一个', async () => {
    await mount()
    await act(async () => {
      source().getState().regenerate('a1')
    })
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('run')
    expect(screen.getByTestId('chat-streaming')).toBeTruthy()
    expect(screen.queryByTestId('chat-readout')).toBeNull()
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
    // G 线 P2-a:滑动的那一口不再收元素(它经 `ScrollPort` 写),只收落点。
    expect([...src.matchAll(/slideScrollTo\(target\)/g)]).toHaveLength(2)
  })
})
