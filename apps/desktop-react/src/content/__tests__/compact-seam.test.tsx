import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { buildContextCompactContent } from '@onething/core/engine'
import { CompactSeam, completedLabel } from '../CompactSeam'
import { parseCompactMarker, type CompactMarker } from '../compact/marker'
import { SegmentView } from '../SegmentView'
import type { BlockCtx } from '../blocks/registry'
import { chatSources } from '../../data/chat-source'
import { configureCommandsPort } from '../../data/commands-port'
import { t } from '../../i18n'
import { useStageStore } from '../../stage/store'

/**
 * 压缩折痕六态(设计正本 `docs/compact-seam-2026-09.md` §3.1)。
 *
 * 值得进 jsdom 的是**判据**那一半:三态各说什么、k/N 出不出、缺格时那句话怎么变、
 * 摘要开不开得了、失败句是不是原样、那颗钮什么时候点不动。至于「光沿线扫」
 * 「线从左填色」—— 那是排版与动效,jsdom 不排版:填色只验那格自定义属性的值,
 * 动效由 `motion-gate`(写法)与 `gate:motion`(真机)两边管。
 */

const SESSION = 's-seam'
const CTX: BlockCtx = { messageId: 'sys-1', streaming: false, sessionId: SESSION }

/** 标记的**产地是后端那只函数** —— 手抄一份 JSON 就是抄一份对协议的理解。 */
function marker(input: Parameters<typeof buildContextCompactContent>[0]): CompactMarker {
  const parsed = parseCompactMarker({ role: 'system', content: buildContextCompactContent(input) })
  if (!parsed) throw new Error('这份夹具不是压缩标记 —— 先修夹具')
  return parsed
}

const compacted: string[] = []

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  chatSources.resetAll()
  compacted.length = 0
  configureCommandsPort({
    ready: async () => undefined,
    listPluginCommands: async () => ({ success: true, commands: [] }),
    executePluginCommand: async () => ({ success: false, error: 'no commands port in tests' }),
    compactContext: async (sessionId) => {
      compacted.push(sessionId)
      return { success: true }
    },
  })
  vi.restoreAllMocks()
})

const seam = () => screen.getByTestId('compact-seam')
const label = () => screen.getByTestId('compact-seam-label')

describe('进行中:光在线上走,k/N 只有多块才出', () => {
  it('单块 —— 一句话,没有 k/N,也没有 --seam-fill(半个进度不是进度)', () => {
    render(<CompactSeam marker={marker({ status: 'compacting', compactedMessageCount: 0 })} ctx={CTX} />)
    expect(seam().dataset.state).toBe('compacting')
    expect(label().textContent).toBe('正在压缩上下文')
    expect(seam().getAttribute('style')).toBeNull()
  })

  it('多块 —— 「2 / 5」在场,线按 chunk/total 从左填', () => {
    render(
      <CompactSeam
        marker={marker({
          status: 'compacting',
          compactedMessageCount: 0,
          progress: { chunk: 2, totalChunks: 5 },
        })}
        ctx={CTX}
      />,
    )
    expect(label().textContent).toBe('正在压缩上下文2 / 5')
    expect(seam().style.getPropertyValue('--seam-fill')).toBe('0.4')
  })

  it('进行中的标签不是折叠件 —— 按下去没有第二件事可做', () => {
    render(<CompactSeam marker={marker({ status: 'compacting', compactedMessageCount: 0 })} ctx={CTX} />)
    expect(label().getAttribute('aria-expanded')).toBeNull()
    expect(screen.queryByTestId('compact-seam-summary')).toBeNull()
  })
})

describe('完成:那句话三种写法,缺一格就少说一句,不编', () => {
  const done = (patch: Record<string, unknown> = {}) =>
    marker({
      status: 'completed',
      compactedMessageCount: 42,
      summary: '## 已完成\n\n- 一条',
      ...patch,
    })

  it('前后读数都在 —— 「已压缩 42 条 · 701.3k → 96k」(进位走 formatQuantity)', () => {
    render(
      <CompactSeam marker={done({ contextSizeBefore: 701_297, retainedContextSize: 96_000 })} ctx={CTX} />,
    )
    expect(completedLabel(t, done({ contextSizeBefore: 701_297, retainedContextSize: 96_000 }))).toBe(
      '已压缩 42 条 · 701.3k → 96k',
    )
    expect(label().textContent).toContain('701.3k → 96k')
  })

  it('缺 before(老会话的标记没有这一格)—— 退成「剩 96k」,不拿后当前', () => {
    expect(completedLabel(t, done({ retainedContextSize: 96_000 }))).toBe('已压缩 42 条 · 剩 96k')
  })

  it('两格都缺 —— 只剩条数', () => {
    expect(completedLabel(t, done())).toBe('已压缩 42 条')
  })

  it('摘要默认折,点标签展开 —— 正文走块渲染,不是一坨 pre-wrap', () => {
    render(<CompactSeam marker={done()} ctx={CTX} />)
    expect(label().getAttribute('aria-expanded')).toBe('false')
    const body = screen.getByTestId('compact-seam-summary')
    expect(body.hasAttribute('hidden')).toBe(true)
    fireEvent.click(label())
    expect(label().getAttribute('aria-expanded')).toBe('true')
    expect(body.hasAttribute('hidden')).toBe(false)
    // markdown 真的被解析过:小标题成了一个标题块,不是一行原文。
    expect(body.querySelector('h2')?.textContent).toBe('已完成')
  })

  it('底部也能收:展开后摘要下面出一枚「收起摘要」,按下合上、底把手退场', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    render(<CompactSeam marker={done()} ctx={CTX} />)
    expect(screen.queryByTestId('compact-seam-foot')).toBeNull()
    fireEvent.click(label())
    const foot = screen.getByTestId('compact-seam-foot')
    expect(foot.textContent).toBe('收起摘要')
    fireEvent.click(foot)
    expect(label().getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('compact-seam-summary').style.display).toBe('none')
    expect(screen.queryByTestId('compact-seam-foot')).toBeNull()
  })

  it('摘要为空 —— 退成一枚普通标签(没有正文的折叠头是在撒谎)', () => {
    render(<CompactSeam marker={done({ summary: '' })} ctx={CTX} />)
    expect(label().getAttribute('aria-expanded')).toBeNull()
    expect(screen.queryByTestId('compact-seam-summary')).toBeNull()
  })
})

describe('失败:provider 那句原话,加一颗行内重试', () => {
  const failed = () =>
    marker({
      status: 'failed',
      compactedMessageCount: 0,
      error:
        'deepseek: maximum context length is 1048576 tokens, requested 1085297 (701297 in the messages, 384000 in the completion)',
    })

  it('原句一字不改地摆着(不改写、不总结)', () => {
    render(<CompactSeam marker={failed()} ctx={CTX} />)
    expect(seam().dataset.state).toBe('failed')
    expect(label().textContent).toBe('压缩失败重试')
    expect(screen.getByTestId('compact-seam-error').textContent).toBe(
      'deepseek: maximum context length is 1048576 tokens, requested 1085297 (701297 in the messages, 384000 in the completion)',
    )
  })

  it('引擎闲着 —— 点重试真的骑上 compactContext(与 /compact 同一条口)', async () => {
    render(<CompactSeam marker={failed()} ctx={CTX} />)
    const retry = screen.getByTestId('compact-seam-retry') as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    fireEvent.click(retry)
    await vi.waitFor(() => expect(compacted).toEqual([SESSION]))
  })

  it('引擎在跑 —— 原生 disabled,连命令都不组(09-08 重试钮判例)', () => {
    chatSources.ensure(SESSION).setState({ activeMessageId: 'a1' })
    render(<CompactSeam marker={failed()} ctx={CTX} />)
    const retry = screen.getByTestId('compact-seam-retry') as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    fireEvent.click(retry)
    expect(compacted).toEqual([])
  })

  it('中断改判(timeline 把卡死的 compacting 判成 failed)走同一支,固定文案照样原样显示', () => {
    render(
      <CompactSeam
        marker={marker({
          status: 'failed',
          compactedMessageCount: 0,
          error: 'Context compact was interrupted before completion.',
        })}
        ctx={CTX}
      />,
    )
    expect(seam().dataset.state).toBe('failed')
    expect(screen.getByTestId('compact-seam-error').textContent).toBe(
      'Context compact was interrupted before completion.',
    )
  })

  it('没有会话上下文(查看器回放)—— 不画一颗不知道打给谁的钮', () => {
    render(<CompactSeam marker={failed()} ctx={{ messageId: 'sys-1', streaming: false }} />)
    expect(screen.queryByTestId('compact-seam-retry')).toBeNull()
    expect(label().textContent).toBe('压缩失败')
  })
})

describe('折痕按物件档留白 —— 节奏表的钩子在', () => {
  it('root 报 data-prose="object"(与错误卡同一档)', () => {
    render(<CompactSeam marker={marker({ status: 'compacting', compactedMessageCount: 0 })} ctx={CTX} />)
    expect(seam().getAttribute('data-prose')).toBe('object')
  })
})

/**
 * 段 → React 那一层接上了没有。
 *
 * 上面每一条都直接渲染 `CompactSeam`,所以它们证明不了「装配管线产出的那个段真的
 * 有人画」—— `SegmentView` 的 switch 少一格是**静默**的(缺席的 case 返回 undefined,
 * 而 undefined 是合法的 ReactNode,tsc 不响)。这一条就是那格哨兵。
 */
describe('SegmentView:compact 段有人画', () => {
  it('段进去,折痕出来', () => {
    render(
      <SegmentView
        segment={{ kind: 'compact', marker: marker({ status: 'compacting', compactedMessageCount: 0 }) }}
        segmentKey="sys-1:0:compact"
        ctx={CTX}
      />,
    )
    expect(seam().dataset.state).toBe('compacting')
  })
})
