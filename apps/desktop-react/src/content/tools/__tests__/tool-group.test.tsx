import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import type { BlockCtx } from '../../blocks/registry'
import type { ProjectedToolCall } from '../../model/segments'
import { presentToolGroup } from '../../assemble/present'
import { ToolGroup } from '../ToolGroup'

/**
 * B2:**计数句收起 ↔ 执行清单展开**的上屏测。
 *
 * 模型那一半(聚合、计数、失败数)在 `assemble/__tests__/group.test.ts` 里钉着;
 * 这里钉的是**画法**里那几条定稿:一句话而不是一堆行、点开才是清单、聚合行
 * 「×N」再点一层、失败置顶。
 */

vi.mock('../../blocks/kinds/code/highlight', () => ({
  loadHighlighter: () => Promise.resolve(undefined),
  highlight: () => undefined,
  HIGHLIGHT_THEME: 'vitesse-light',
  resetHighlighterForTest: () => undefined,
}))

const T0 = 1_700_000_000_000
const ctx: BlockCtx = { messageId: 'a1', streaming: false }

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

function call(id: string, toolName = 'read', patch: Record<string, unknown> = {}): ProjectedToolCall {
  return {
    id,
    toolId: toolName,
    toolName,
    arguments: toolName === 'bash' ? { command: `cmd-${id}` } : { path: `${id}.ts` },
    status: 'completed',
    timestamp: T0,
    ...patch,
  } as unknown as ProjectedToolCall
}

async function draw(calls: ProjectedToolCall[]) {
  const view = render(<ToolGroup group={presentToolGroup(calls)} ctx={ctx} />)
  await act(async () => undefined)
  return view
}

const open = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('收起 = 一句计数句', () => {
  it('「执行了 N 步 · 名1 / 名2」+ 右端总耗时', async () => {
    const { container } = await draw([
      call('c1', 'read', { durationMs: 120 }),
      call('c2', 'bash', { durationMs: 380 }),
    ])
    const head = container.querySelector('button')!
    expect(head.textContent).toContain('执行了 2 步')
    expect(head.textContent).toContain('read / bash')
    // 总耗时 = 各次之和;不到一秒按毫秒说(「1234ms」没人读得快,所以秒以上才换单位)。
    expect(head.textContent).toContain('500ms')
    // 收起时清单不在场 —— 它是一句话,不是一堆折起来的行。
    expect(container.querySelector('ul')).toBeNull()
  })

  it('过了一秒换单位说 —— 「2.0s」比「2010ms」读得快', async () => {
    const { container } = await draw([call('c1', 'read', { durationMs: 2010 })])
    expect(container.querySelector('button')!.textContent).toContain('2.0s')
  })

  it('超过三种折成「等 N 种」—— 列到第四个名字人就开始数了', async () => {
    const { container } = await draw([
      call('c1', 'read'),
      call('c2', 'edit'),
      call('c3', 'bash'),
      call('c4', 'web_search'),
      call('c5', 'grep'),
    ])
    const head = container.querySelector('button')!
    expect(head.textContent).toContain('read / edit / bash')
    expect(head.textContent).toContain('等 5 种')
    expect(head.textContent).not.toContain('web_search')
  })

  it('有失败就在右端亮一句红', async () => {
    const { container } = await draw([
      call('c1'),
      call('c2', 'read', { status: 'failed', error: '炸了' }),
    ])
    expect(container.querySelector('button')!.textContent).toContain('1 失败')
  })
})

describe('展开 = 执行清单', () => {
  it('点开成清单,每一格一行', async () => {
    const { container } = await draw([call('c1', 'read'), call('c2', 'bash')])
    await open(container.querySelector('button')!)
    expect(container.querySelectorAll('ul > li')).toHaveLength(2)
    expect(container.textContent).toContain('c1.ts')
    expect(container.textContent).toContain('cmd')
  })

  it('同名连发在清单里是一行「×N」,点开才逐条', async () => {
    const { container } = await draw([call('c1'), call('c2'), call('c3')])
    await open(container.querySelector('button')!)
    expect(container.querySelectorAll('ul > li')).toHaveLength(1)
    expect(container.textContent).toContain('×3')
    // 聚合着的时候逐条不在场。
    expect(container.textContent).not.toContain('c2.ts')

    const aggregate = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('×3'),
    )!
    await open(aggregate)
    expect(container.textContent).toContain('c1.ts')
    expect(container.textContent).toContain('c3.ts')
  })

  it('聚合行点开后**失败置顶**,其余保持原顺序', async () => {
    const { container } = await draw([
      call('c1'),
      call('c2'),
      call('c3', 'read', { status: 'failed', error: '炸了' }),
    ])
    await open(container.querySelector('button')!)
    await open(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('×3'))!)
    const names = Array.from(container.querySelectorAll('ul ul > li')).map(
      (item) => item.textContent?.slice(0, 5),
    )
    expect(names).toEqual(['c3.ts', 'c1.ts', 'c2.ts'])
  })

  it('清单里的行同样能拉开 C1 抽屉(嵌套复用一路到底)', async () => {
    const { container } = await draw([
      call('c1', 'read', { result: { content: [{ type: 'text', text: 'const a = 1' }] } }),
      call('c2', 'bash'),
    ])
    await open(container.querySelector('button')!)
    const row = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('c1.ts'),
    )!
    await open(row)
    expect(screen.getByText('结果')).toBeTruthy()
    expect(container.querySelector('[data-block-kind="code"]')).toBeTruthy()
  })
})
