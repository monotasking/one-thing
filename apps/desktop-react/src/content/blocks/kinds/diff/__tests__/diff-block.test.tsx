import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BlockView } from '../../../BlockView'
import type { BlockCtx } from '../../../registry'
import type { BlockModel } from '../../../../model/blocks'
import type { ProjectedToolCall } from '../../../../model/segments'
import { routeFence } from '../../../../markdown/fence'
import { resolveToolPresenter } from '../../../../tools/presenter'
import '../../../../tools/presenters'
import { useStageStore } from '../../../../../stage/store'

/**
 * diff 一等块的上屏判据 + **两个产地同一个块**的钉子。
 *
 * 后半条是这一批存在的理由:P2 的留账说「markdown 的 ```diff 与 edit 工具的 detail
 * 必须同批切到同一个块」。写成断言而不是写成注释,是因为下一个人拆掉其中一边时,
 * 注释不会红,这条会。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

const ctx: BlockCtx = { messageId: 'm1', streaming: false }
const draw = (block: BlockModel) => render(<BlockView block={block} ctx={ctx} />)

const DIFF = ['@@ -10,3 +10,4 @@ function boot()', ' keep', '-old line', '+new line', '+extra'].join('\n')

describe('diff 定稿形', () => {
  it('檐:类型词 diff + 文件路径 + ±统计色字(不是徽章:两枚字,颜色分开)', () => {
    const { container } = draw({
      kind: 'diff',
      file: 'src/app.ts',
      source: DIFF,
      hunks: [{ header: '@@ -1 +1 @@', newStart: 1, lines: [{ kind: 'add', text: 'a' }] }],
      stat: { add: 12, del: 3 },
    })
    const eave = container.querySelector('header')!
    expect(eave.textContent).toContain('diff')
    expect(eave.textContent).toContain('src/app.ts')
    expect(eave.textContent).toContain('+12')
    // 真减号,与工具行的读数同字形。
    expect(eave.textContent).toContain('−3')
  })

  it('零是真值:`+0 −0` 照说', () => {
    const { container } = draw({
      kind: 'diff',
      source: '@@ -1 +1 @@\n ctx',
      hunks: [{ header: '@@ -1 +1 @@', newStart: 1, lines: [{ kind: 'ctx', text: 'ctx' }] }],
      stat: { add: 0, del: 0 },
    })
    expect(container.querySelector('header')?.textContent).toContain('+0')
  })

  it('hunk 头画成一行原文', () => {
    const { container } = draw(parsed())
    expect(container.textContent).toContain('@@ -10,3 +10,4 @@ function boot()')
  })

  it('增删行各自带上自己的类名(行底色由 CSS 认这一格)', () => {
    const { container } = draw(parsed())
    const rows = Array.from(container.querySelectorAll('[class*="row"]'))
    const classesOf = (text: string) =>
      rows.find((row) => row.textContent?.includes(text))?.className ?? ''
    expect(classesOf('new line')).toMatch(/add/)
    expect(classesOf('old line')).toMatch(/del/)
    expect(classesOf('keep')).toMatch(/ctx/)
  })

  it('+/− 符号在自己的格里(满饱和色上在它身上,不上在整行文字上)', () => {
    const { container } = draw(parsed())
    const signs = Array.from(container.querySelectorAll('[class*="sign"]')).map((n) => n.textContent)
    expect(signs).toEqual([' ', '−', '+', '+'])
  })

  it('行号单列 = 新文件行号;删除行那一格空着', () => {
    const { container } = draw(parsed())
    const nums = Array.from(container.querySelectorAll('[class*="num"]')).map((n) => n.textContent)
    // ctx(10) · del(空) · add(11) · add(12)
    expect(nums).toEqual(['10', '', '11', '12'])
  })

  it('碎片 diff 没有起始行号时整列空着 —— 不编一个', () => {
    const { container } = draw(routeFence('diff', '+a\n-b', true))
    const nums = Array.from(container.querySelectorAll('[class*="num"]')).map((n) => n.textContent)
    expect(nums).toEqual(['', ''])
  })

  it('动作只有一个:复制原始 diff 文本', () => {
    draw(parsed())
    expect(screen.getByText('复制源码')).toBeTruthy()
  })
})

describe('两个产地,同一个块(P2 留账的钉子)', () => {
  const raw = '@@ -1,2 +1,2 @@\n-old\n+new'

  it('markdown 的 ```diff 围栏渲出 data-block-kind="diff"', () => {
    const { container } = draw(routeFence('diff', raw, true))
    expect(container.querySelector('[data-block-kind="diff"]')).toBeTruthy()
  })

  it('edit 工具的 detail 渲出同一个 data-block-kind="diff"', () => {
    const call = {
      id: 'c1',
      toolId: 'edit',
      toolName: 'edit',
      arguments: { path: '/repo/a.ts' },
      status: 'completed',
      timestamp: 1_700_000_000_000,
      changes: { filePath: '/repo/a.ts', diff: raw },
    } as unknown as ProjectedToolCall
    const [block] = resolveToolPresenter(call).detail(call)
    const { container } = draw(block)
    expect(container.querySelector('[data-block-kind="diff"]')).toBeTruthy()
  })

  it('同一段 diff 两个产地的正文逐字相同 —— 差别只在檐上的文件路径', () => {
    const fromMarkdown = draw(routeFence('diff', raw, true)).container
    const call = {
      id: 'c1',
      toolId: 'edit',
      toolName: 'edit',
      arguments: {},
      status: 'completed',
      timestamp: 1_700_000_000_000,
      changes: { diff: raw },
    } as unknown as ProjectedToolCall
    const [block] = resolveToolPresenter(call).detail(call)
    const fromTool = draw(block).container
    const bodyOf = (root: HTMLElement) => root.querySelector('[class*="diff"]')?.textContent
    expect(bodyOf(fromTool)).toBe(bodyOf(fromMarkdown))
  })
})

function parsed(): BlockModel {
  return routeFence('diff', DIFF, true)
}
