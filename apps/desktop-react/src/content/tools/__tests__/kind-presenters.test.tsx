import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import type { BlockCtx } from '../../blocks/registry'
import type { ProjectedToolCall } from '../../model/segments'
import { presentToolCard, presentToolRow } from '../../assemble/present'
import { ToolCard } from '../ToolCard'
import { defaultToolPresenter, resolveToolPresenter } from '../presenter'
import { presenterForKind } from '../presenters/kind'
import { readPresenter } from '../presenters/read'
import { editPresenter } from '../presenters/edit'
import { bashPresenter } from '../presenters/bash'
import { webPresenter } from '../presenters/web'
import { configureTerminalPort, type TerminalPort } from '../../../data/terminal-port'
import { resetTerminalSource } from '../../../data/terminal-source'
import '../presenters'

/**
 * ACP A2-c 工具卡保真的单测:**类别表**、对象结局、任意类别的 diff、卡脚(位置 / 终端)、
 * 自报阶段词。素材按 A2-a 之后后端真发的形造:`toolCall.result` 是
 * `{ output, metadata: { kind, locations?, terminalId? } }`,`changes` 在调用自己身上
 * (`hunks` 为空,只有 `diff` 文本)。
 */

vi.mock('../../code/highlight', () => ({
  loadHighlighter: () => Promise.resolve(undefined),
  highlight: () => undefined,
  HIGHLIGHT_THEME: 'vitesse-light',
  resetHighlighterForTest: () => undefined,
}))

const reveal = vi.fn()
vi.mock('../../terminal-launcher', () => ({ revealTerminal: (id: string) => reveal(id) }))

const T0 = 1_700_000_000_000
const ctx: BlockCtx = { messageId: 'a1', streaming: false }

const DIFF = [
  '--- a/rich.txt',
  '+++ b/rich.txt',
  '@@ -1,3 +1,4 @@',
  ' alpha',
  '-beta',
  '+BETA',
  ' gamma',
  '+delta',
  '',
].join('\n')

function acpCall(patch: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}): ProjectedToolCall {
  return {
    id: 'rich-edit-1',
    toolId: 'edit_file',
    toolName: 'edit_file',
    arguments: { path: '/w/rich.txt' },
    status: 'completed',
    timestamp: T0,
    result: { output: '', metadata: { kind: 'edit', ...metadata } },
    ...patch,
  } as unknown as ProjectedToolCall
}

function terminalPortWith(ids: string[]): TerminalPort {
  return {
    ready: async () => undefined,
    list: async () => ({
      success: true,
      terminals: ids.map((id) => ({ id, title: id, cwd: '/w', shell: 'sh', cols: 80, rows: 24, createdAt: T0 })),
    }),
  } as unknown as TerminalPort
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  reveal.mockClear()
})

afterEach(() => {
  configureTerminalPort(undefined)
  resetTerminalSource()
})

describe('类别表:按 kind 选画法,不按工具名 / agent', () => {
  it('每一档类别落到约好的那个 presenter,表外的落兜底', () => {
    expect(presenterForKind('read')).toBe(readPresenter)
    expect(presenterForKind('edit')).toBe(editPresenter)
    expect(presenterForKind('delete')).toBe(editPresenter)
    expect(presenterForKind('move')).toBe(editPresenter)
    expect(presenterForKind('execute')).toBe(bashPresenter)
    expect(presenterForKind('fetch')).toBe(webPresenter)
    for (const kind of ['search', 'think', 'switch_mode', 'other', 'brand-new', undefined]) {
      expect(presenterForKind(kind)).toBe(defaultToolPresenter)
    }
    // 原型链上的名字不是类别(表是明表,不是对象的全部键)。
    expect(presenterForKind('toString')).toBe(defaultToolPresenter)
  })

  it('结局里有 kind 的调用归类别表;名字就是 agent 起的那个,文件名挪进摘要', () => {
    const row = presentToolRow(acpCall())
    expect(row).toMatchObject({ icon: 'Pencil', name: 'edit_file', summary: 'rich.txt' })
    expect(row.headLabel).toBeUndefined()
  })

  it('execute 借 bash 的画法,但头行 / 行名念工具名而不是命令首词', () => {
    const call = acpCall(
      { toolName: 'run', toolId: 'run', arguments: { command: 'echo rich' } },
      { kind: 'execute' },
    )
    const row = presentToolRow(call)
    expect(row).toMatchObject({ icon: 'Terminal', name: 'run' })
    expect(row.headLabel).toBeUndefined()
  })

  it('内置工具的结局里没有 kind —— 类别表一个都不认,照旧按名字', () => {
    const local = acpCall({ toolName: 'read', toolId: 'read', result: { output: 'x', metadata: { lineCount: 3 } } })
    // 覆盖掉 kind:用内置那份结局。
    ;(local as { result: unknown }).result = { output: 'x', metadata: { lineCount: 3 } }
    expect(resolveToolPresenter(local)).toBe(readPresenter)
  })
})

describe('对象结局:兜底画 output,不画 JSON', () => {
  it('`{ output, metadata }` → 一段素文本,metadata 不摊', () => {
    const call = acpCall({ result: { output: 'thinking done', metadata: { kind: 'think' } } })
    const blocks = resolveToolPresenter(call).detail(call)
    expect(blocks).toEqual([{ kind: 'code', lang: null, source: 'thinking done', closed: true }])
  })

  it('裸字符串结局照旧是 JSON 原样(本地工具的兜底不变)', () => {
    const call = acpCall({ toolName: 'brand_new', toolId: 'brand_new', result: 'r' })
    const blocks = defaultToolPresenter.detail(call)
    expect(blocks[0]).toMatchObject({ kind: 'source-fallback', reason: 'tool-default' })
  })

  it('output 是空串 = 工具明说没有正文 → 结果一节为空', () => {
    const call = acpCall({ result: { output: '', metadata: { kind: 'other' } } })
    expect(resolveToolPresenter(call).detail(call)).toEqual([])
  })
})

describe('diff:changes 在场就是那一块 diff,不管类别', () => {
  it('execute 带着改动 → diff 块排在输出前面', () => {
    const call = acpCall(
      {
        toolName: 'run',
        toolId: 'run',
        arguments: { command: 'sed -i s/beta/BETA/ rich.txt' },
        result: { output: 'ok', metadata: { kind: 'execute' } },
        changes: { filePath: '/w/rich.txt', diff: DIFF, additions: 2, deletions: 1, hunks: [] },
      },
    )
    const blocks = resolveToolPresenter(call).detail(call)
    expect(blocks[0]).toMatchObject({ kind: 'diff', stat: { add: 2, del: 1 } })
    expect(blocks[1]).toMatchObject({ kind: 'code', source: 'ok' })
  })

  it('edit 类只画一块(不重复加)', () => {
    const call = acpCall({ changes: { filePath: '/w/rich.txt', diff: DIFF, additions: 2, deletions: 1, hunks: [] } })
    const blocks = resolveToolPresenter(call).detail(call)
    expect(blocks.filter((b) => b.kind === 'diff')).toHaveLength(1)
  })

  it('还没有类别(执行中)的调用带着改动,兜底也画那一块', () => {
    const call = acpCall({
      status: 'executing',
      result: undefined,
      changes: { filePath: '/w/rich.txt', diff: DIFF, additions: 2, deletions: 1, hunks: [] },
    })
    expect(resolveToolPresenter(call)).toBe(defaultToolPresenter)
    expect(resolveToolPresenter(call).detail(call)[0]).toMatchObject({ kind: 'diff' })
  })
})

async function draw(calls: ProjectedToolCall[]) {
  const view = render(<ToolCard card={presentToolCard(calls)} ctx={ctx} />)
  await act(async () => undefined)
  return view
}

describe('卡脚:位置与终端', () => {
  it('locations → 一行可点的 path:line(文件引用那一枚)', async () => {
    const { container } = await draw([acpCall({}, { locations: [{ path: '/w/rich.txt', line: 3 }, { path: '/w/b.ts' }] })])
    const foot = container.querySelector('[data-tool-foot="rich-edit-1"]')
    expect(foot).toBeTruthy()
    const marks = Array.from(foot!.querySelectorAll('[data-tool-location]')).map((el) => el.getAttribute('data-tool-location'))
    expect(marks).toEqual(['/w/rich.txt:3', '/w/b.ts'])
    // 画的是引用种类表里 `file` 那一枚(与正文里的文件引用同一件),带行号那一截。
    expect(foot!.querySelector('[data-ref-kind="fileRef"]')?.textContent).toContain(':3')
  })

  it('本地工具(两格都没有)一个卡脚节点都不多', async () => {
    const { container } = await draw([
      { ...acpCall(), toolName: 'read', toolId: 'read', result: { output: 'x', metadata: {} } } as ProjectedToolCall,
    ])
    expect(container.querySelector('[data-tool-foot]')).toBeNull()
  })

  it('终端在名单里 → 「打开终端」可点,点了就摆那一格', async () => {
    configureTerminalPort(terminalPortWith(['term-1']))
    const { container } = await draw([acpCall({}, { kind: 'execute', terminalId: 'term-1' })])
    const button = container.querySelector('[data-tool-terminal="term-1"]') as HTMLButtonElement
    expect(button.textContent).toBe('打开终端')
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull())
    await act(async () => {
      fireEvent.click(button)
    })
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('term-1'))
  })

  it('终端已不在名单里 → 灰(aria-disabled),点击恒等', async () => {
    configureTerminalPort(terminalPortWith(['someone-else']))
    const { container } = await draw([acpCall({}, { kind: 'execute', terminalId: 'term-1' })])
    const button = () => container.querySelector('[data-tool-terminal="term-1"]') as HTMLButtonElement
    await waitFor(() => expect(button().getAttribute('aria-disabled')).toBe('true'))
    await act(async () => {
      fireEvent.click(button())
    })
    expect(reveal).not.toHaveBeenCalled()
  })
})

describe('自报阶段词:等待 / 进行中', () => {
  it('还在跑、metadata 带 in_progress → 右端说「进行中」', async () => {
    const call = acpCall({ status: 'executing', result: { output: '', metadata: { kind: 'edit', status: 'in_progress' } } })
    const { container } = await draw([call])
    expect(container.querySelector('[data-tool-phase="in_progress"]')?.textContent).toBe('进行中')
  })

  it('pending → 「等待」;收场之后就不说了', async () => {
    const pending = acpCall({ status: 'executing', result: { output: '', metadata: { status: 'pending' } } })
    const { container, rerender } = await draw([pending])
    expect(container.querySelector('[data-tool-phase="pending"]')?.textContent).toBe('等待')
    rerender(<ToolCard card={presentToolCard([acpCall()])} ctx={ctx} />)
    expect(container.querySelector('[data-tool-phase]')).toBeNull()
  })
})
