import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ContextDeltaSeam,
  contextDeltaEntries,
  contextDeltaSummary,
  hasContextDelta,
  type TurnContextDelta,
} from '../ContextDeltaSeam'
import { ChatStream } from '../ChatStream'
import { configureChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import { useExposeStore } from '../../expose/store'
import { act, waitFor } from '@testing-library/react'
import { t } from '../../i18n'
import { useStageStore } from '../../stage/store'

/**
 * 上下文更新折痕(设计正本 `docs/compact-seam-2026-09.md` §3.2;09-09 用户裁定
 * 把它从「气泡下的 chip」推翻成「用户行与下一行之间的一道折痕」)。
 *
 * 值得进 jsdom 的只有**判据**那一半:出不出、头上那行字怎么算、展开列几行、
 * 墓碑行报不报身份、键盘开不开得了,以及 09-09 那条新判据 —— **它落在哪一行**。
 * 至于「线怎么画」「钳到 320px」—— 那是排版,jsdom 不排版,由真机门量
 * (`gate:squeeze` / `gate:a11y`)。划线那一句是 CSS 的事实,所以按
 * `.ghost:disabled` 那条判例的办法:**读样式表**。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

const label = () => screen.queryByTestId('context-delta-label')

describe('没有 delta 就没有这道折痕', () => {
  it('turnContext 缺席 —— 一个像素都不占', () => {
    const { container } = render(<ContextDeltaSeam />)
    expect(container.innerHTML).toBe('')
    expect(label()).toBeNull()
  })

  it('turnContext 在,但 set / removed 都空 —— 同样不出', () => {
    const { container } = render(<ContextDeltaSeam turnContext={{ set: {}, removed: [] }} />)
    expect(container.innerHTML).toBe('')
  })

  /*
   * `hasContextDelta` 是 `ChatStream` 在 `messages.map` 里问的那一句(不分配的写法,
   * 理由见它自己的注)。它与 `contextDeltaEntries` 分叉就会出一行空折痕、或者
   * 该出的不出 —— 所以两者在同一组素材上逐条对表。
   */
  it('hasContextDelta 与 contextDeltaEntries 说的是同一件事', () => {
    const cases: (TurnContextDelta | undefined)[] = [
      undefined,
      {},
      { set: {} },
      { removed: [] },
      { set: {}, removed: [] },
      { set: { todo: 'x' } },
      { removed: ['skills'] },
      { set: {}, removed: ['skills'] },
    ]
    for (const delta of cases) {
      expect([delta, hasContextDelta(delta)]).toEqual([delta, contextDeltaEntries(delta).length > 0])
    }
  })
})

describe('折叠头:文字读数,不是徽标', () => {
  it('按名字归并计数,removed 合成一格「移除 N」', () => {
    render(
      <ContextDeltaSeam
        turnContext={{
          set: { variables: 'cwd=/tmp', todo: '- [ ] A1' },
          removed: ['skills'],
        }}
      />,
    )
    expect(label()?.textContent).toBe('上下文更新 · 变量 1 · 待办 1 · 移除 1')
  })

  it('同族多块读作一格 —— 三个插件提供方是「插件 3」,不是三段各说一遍', () => {
    const summary = contextDeltaSummary(
      t,
      contextDeltaEntries({
        set: {
          'plugin:log-monitor/default': 'a',
          'plugin:note-skills/notes': 'b',
          'plugin:note-skills/tags': 'c',
        },
      }),
    )
    expect(summary).toBe('上下文更新 · 插件 3')
  })

  it('壳不认识的块 id 原样显示 —— 数据照说,不报错也不吞掉', () => {
    render(<ContextDeltaSeam turnContext={{ set: { 'lab:experiment': 'x' } }} />)
    expect(label()?.textContent).toBe('上下文更新 · lab:experiment 1')
  })

  it('折叠是默认档 —— 回合刚开张时用户在等回复,不在读这一段', () => {
    render(<ContextDeltaSeam turnContext={{ set: { todo: '- [ ] A1' } }} />)
    expect(label()?.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('context-delta-body').hasAttribute('hidden')).toBe(true)
  })
})

describe('底部收起', () => {
  it('展开后正文下面出一枚「收起」,按下合上、底把手退场', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    render(<ContextDeltaSeam turnContext={{ set: { variables: 'cwd=/tmp' } }} />)
    expect(screen.queryByTestId('context-delta-foot')).toBeNull()
    fireEvent.click(label()!)
    const foot = screen.getByTestId('context-delta-foot')
    expect(foot.textContent).toBe('收起')
    fireEvent.click(foot)
    expect(label()!.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('context-delta-body').style.display).toBe('none')
    expect(screen.queryByTestId('context-delta-foot')).toBeNull()
  })
})

describe('展开:每块一行', () => {
  it('逐块列出,左列块名右列正文', () => {
    render(
      <ContextDeltaSeam turnContext={{ set: { variables: 'cwd=/tmp', 'agents-md': '# 规则' } }} />,
    )
    fireEvent.click(label()!)
    const body = screen.getByTestId('context-delta-body')
    expect(body.hasAttribute('hidden')).toBe(false)
    const rows = [...body.querySelectorAll('[data-block-id]')]
    expect(rows.map((row) => row.getAttribute('data-block-id'))).toEqual(['variables', 'agents-md'])
    expect(rows[0]?.textContent).toBe('变量cwd=/tmp')
    expect(rows[1]?.textContent).toBe('项目约定# 规则')
  })

  it('正文原样(换行是事实,不截字符串)', () => {
    render(<ContextDeltaSeam turnContext={{ set: { todo: '- [ ] A1\n- [x] 文档' } }} />)
    fireEvent.click(label()!)
    const row = screen.getByTestId('context-delta-body').querySelector('[data-block-id="todo"]')
    expect(row?.textContent).toBe('待办- [ ] A1\n- [x] 文档')
  })

  it('Enter 展开(结构键,由 ui/Fold 提供,本件不写第二份)', () => {
    render(<ContextDeltaSeam turnContext={{ set: { todo: '- [ ] A1' } }} />)
    fireEvent.keyDown(label()!, { key: 'Enter' })
    expect(label()?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('context-delta-body').hasAttribute('hidden')).toBe(false)
  })

  it('aria-controls 指向那份正文(FoldBody 挂载时自己登记的)', () => {
    render(<ContextDeltaSeam turnContext={{ set: { todo: '- [ ] A1' } }} />)
    expect(label()?.getAttribute('aria-controls')).toBe(
      screen.getByTestId('context-delta-body').id,
    )
  })
})

describe('removed:墓碑行', () => {
  it('排在 set 之后,报得出身份,正文是「已移除」', () => {
    render(<ContextDeltaSeam turnContext={{ set: { todo: 'x' }, removed: ['skills'] }} />)
    fireEvent.click(label()!)
    const rows = [...screen.getByTestId('context-delta-body').querySelectorAll('[data-block-id]')]
    expect(rows.map((row) => row.getAttribute('data-block-id'))).toEqual(['todo', 'skills'])
    const tomb = rows[1] as HTMLElement
    expect(tomb.getAttribute('data-removed')).toBe('')
    expect(tomb.textContent).toBe('技能已移除')
  })

  it('set 的行不带墓碑标记', () => {
    render(<ContextDeltaSeam turnContext={{ set: { todo: 'x' } }} />)
    fireEvent.click(label()!)
    const row = screen.getByTestId('context-delta-body').querySelector('[data-block-id="todo"]')
    expect(row?.hasAttribute('data-removed')).toBe(false)
  })

  /*
   * 划线是 CSS 的事实,jsdom 不算层叠 —— 按 `.ghost:disabled` 那条判例读样式表原文。
   * 读之前先剥注释(病历文本里出现同样的字会让断言自红,那是本仓的既有判例)。
   */
  it('墓碑整行划线(名字也划:说的是「这一块不在了」,不是「值变了」)', () => {
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../ContextDeltaSeam.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = css.match(/\.entry\[data-removed\]\s*\{([^}]*)\}/)
    expect(rule?.[1]).toContain('text-decoration: line-through')
  })
})

/**
 * ── 09-09 那条裁定的落点(报障二:「不要放在消息气泡下面」)──────────────
 *
 * 上面每一条都直接渲染 `ContextDeltaSeam`,所以它们证明不了**这道折痕摆在哪儿**。
 * 这一组走真的数据源 + 真的 `ChatStream`:折痕必须是用户那一行**之后**、下一行
 * **之前**的独立一行,而用户那一行里一个字都不许有。
 */
const T0 = 1_700_000_000_000
const SESSION = 'ctx-delta'

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
    type: 'context/turn-update',
    data: { messageId: 'm1', set: { todo: '- [ ] A1' } },
  },
  { seq: 4, time: T0, type: 'run/start', data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 } },
  {
    seq: 5,
    time: T0,
    type: 'assistant/chunks',
    data: { runId: 'r1', requestIndex: 0, messageId: 'a1', partIndex: 0, kind: 'text', time0: T0, dt: [0], text: ['好的'] },
  },
]

async function mountStream(ledger: Ledger[] = LEDGER) {
  configureChatPort({
    ready: async () => undefined,
    /*
     * 页那条路在这只假端口上**说不**(工单 5 ③)—— 于是这一台退回整份账本,
     * 也就是这些用例本来就在测的那条路。假端口给一份空页会把树画成空的,
     * 那是造事实;说不才是它此刻的真话。
     */
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: [...ledger] as never }),
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
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<ChatStream sessionId={SESSION} />)
  })
  await waitFor(() =>
    expect(chatSources.ensure(SESSION).getState().status).not.toBe('loading'),
  )
  return view
}

describe('落点:回合的事,不是用户说的话', () => {
  beforeEach(() => {
    chatSources.ensure(SESSION).getState().reset()
    useExposeStore.setState({ currentSessionId: '' })
  })

  it('折痕紧跟在用户那一行之后、下一条之前', async () => {
    const { container } = await mountStream()
    const seamRow = container.querySelector('[data-context-of="m1"]')
    expect(seamRow).toBeTruthy()
    // 前一个兄弟 = 那条用户消息;后一个兄弟 = 下一条(助手)。
    const before = seamRow!.previousElementSibling as HTMLElement
    const after = seamRow!.nextElementSibling as HTMLElement
    expect(before.getAttribute('data-message-id')).toBe('m1')
    expect(before.getAttribute('data-role')).toBe('user')
    expect(after.getAttribute('data-message-id')).toBe('a1')
    // 它自己不是一条消息 —— 挂上 data-message-id 会让 TOC 的键落到一行折痕上。
    expect(seamRow!.hasAttribute('data-message-id')).toBe(false)
    expect(seamRow!.querySelector('[data-testid="context-delta-label"]')).toBeTruthy()
  })

  it('用户那一行里没有任何「上下文更新」的元素', async () => {
    const { container } = await mountStream()
    const userRow = container.querySelector('article[data-role="user"]')!
    expect(userRow.querySelector('[data-testid="context-delta-label"]')).toBeNull()
    expect(userRow.querySelector('[data-testid="context-delta-body"]')).toBeNull()
    expect(userRow.textContent).toBe('你好')
  })
})

/**
 * ── 等待指示**只留一处:尾部**(2026-09-20 G 线 P1,正本
 *    `docs/stream-geometry-2026-09.md` §2 拍点 2)────────────────────────────
 *    ── 而那一处 2026-09-21 起**不扫了**(P1b 裁定 B,§8)──────────────────
 *
 * 这一族 09-15 立案时钉的是「等待与上下文更新合成一行:有上下文更新行时由它扫
 * (`sweeping`),没有时才由 `WaitingSeam` 画一道空的」。**那条规矩整条被推翻了**
 * —— 用户 09-20 报的第一件事就是「发送之后屏上有两处在等的动画」,裁定是等待指示
 * 只留尾部那一处(整列末尾的尾槽)。09-21 再推一次:用户「保留的尾部的 generate
 * 不需要是一个横线,和之前的样式一致即可」,于是那道横线(`WaitingSeam`)整件删掉,
 * 尾槽从开张到收场只有一张脸 —— 呼吸光标 + 读数 + 停止。
 *
 * 所以旧断言这样迁:
 *  · 「sweeping 翻的是折痕自己那格状态」→ 那格 prop 已经删掉,改钉**它恒 settled**;
 *  · 「有上下文更新行时它在扫 / 没有时才轮到 WaitingSeam」→ **不论有没有上下文
 *    更新行,屏上都没有第二处在等的动画,而在跑这件事由尾槽那一格说**;
 *  · 「首字到了折痕落定」→ 留着,只是它从来就没离开过 `settled`,而尾槽那一格
 *    在首字前后**逐字不变**(那正是裁定 B 要的)。
 */
describe('等待期间:说「在跑」的只有尾槽那一格', () => {
  /** 与 `LEDGER` 同形,只是回复还没开口(没有 `assistant/chunks`)。 */
  const WAITING: Ledger[] = LEDGER.slice(0, 4)
  /** 同上,但这一轮**没有**上下文更新 —— 那一行于是不存在。 */
  const WAITING_NO_DELTA: Ledger[] = WAITING.filter((e) => e.type !== 'context/turn-update')

  beforeEach(() => {
    chatSources.ensure(SESSION).getState().reset()
    useExposeStore.setState({ currentSessionId: '' })
  })

  it('直接渲染:它**恒** settled —— 上下文更新是已经发生完的事', () => {
    render(<ContextDeltaSeam turnContext={{ set: { todo: 'x' } }} />)
    const seam = screen.getByTestId('context-delta-seam')
    expect(seam.getAttribute('data-state')).toBe('settled')
    expect(label()).toBeTruthy()
  })

  it('这一轮有上下文更新行:它不扫,在跑这件事由尾槽说', async () => {
    await mountStream(WAITING)
    expect(screen.getByTestId('context-delta-seam').getAttribute('data-state')).toBe('settled')
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('run')
    expect(screen.getByTestId('chat-streaming').closest('[data-tail-slot]')).toBeTruthy()
  })

  it('这一轮没有上下文更新行:说话的还是同一格(位置不随内容变)', async () => {
    await mountStream(WAITING_NO_DELTA)
    expect(screen.queryByTestId('context-delta-seam')).toBeNull()
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('run')
    expect(screen.getByTestId('chat-streaming').closest('[data-tail-slot]')).toBeTruthy()
  })

  /**
   * 屏上在扫的**一道都没有** —— 用户 09-20 报的「两处在等的动画」是这一条的前身,
   * 09-21 那道线本身也退役了,所以今天的判据比那时更硬:一处都不许有。
   */
  it('屏上没有任何一道在扫的线', async () => {
    await mountStream(WAITING)
    expect(document.querySelectorAll('[data-state="running"]')).toHaveLength(0)
    expect(screen.queryByTestId('waiting-seam')).toBeNull()
  })

  /**
   * 首字到达在尾槽那一格里**什么都不发生**(裁定 B):它只知道「在跑」。
   * 这一条是从前那条「同格换手」的继任者 —— 判据从「哪张脸亮着」变成
   * 「压根没有第二张脸可换」。
   */
  it('首字到了:尾槽那一格逐字不变,折痕照旧 settled', async () => {
    await mountStream(LEDGER)
    expect(screen.getByTestId('context-delta-seam').getAttribute('data-state')).toBe('settled')
    expect(screen.getByTestId('chat-tail-slot').getAttribute('data-face')).toBe('run')
    expect(screen.queryByTestId('waiting-seam')).toBeNull()
  })
})
