import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BlockView } from '../../../BlockView'
import type { BlockCtx } from '../../../registry'
import type { BlockModel } from '../../../../model/blocks'
import type { ProjectedToolCall } from '../../../../model/segments'
import { routeFence } from '../../../../markdown/fence'
import { resolveToolPresenter } from '../../../../tools/presenter'
import '../../../../tools/presenters'
import { useStageStore } from '../../../../../stage/store'
import { hunkCodeLines } from '../Diff'

/*
 * 假高亮器:**按 lang 有没有**决定给不给 token,按 `\n` 切行 —— 与真 shiki 在这条
 * 链路上唯一重要的性质相同(一次染整段、按行取回)。真 shiki 在 jsdom 里要拉十六份
 * grammar,而这里要验的是「lang 从文件名来」与「token 按行落到行上」,不是配色。
 */
vi.mock('../../../../code/highlight', () => ({
  loadHighlighter: () => Promise.resolve({}),
  highlight: (source: string, lang: string | null) =>
    lang === null
      ? undefined
      : source.split('\n').map((text) => [{ content: text, color: '#123456', offset: 0 }]),
  HIGHLIGHT_THEME: 'vitesse-light',
  resetHighlighterForTest: () => undefined,
}))

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
    // 批 ②:行交给基础件之后取件口从 `.row` 换成 `.line`,未改的行**一个状态类都不带**
    //(从前有一个画 `background: transparent` 的 `.ctx`,那是在说一句空话)。
    const { container } = draw(parsed())
    const rows = Array.from(container.querySelectorAll('[class*="line"]'))
    const classesOf = (text: string) =>
      rows.find((row) => row.textContent?.includes(text))?.className ?? ''
    expect(classesOf('new line')).toMatch(/lineAdd/)
    expect(classesOf('old line')).toMatch(/lineDel/)
    expect(classesOf('keep')).not.toMatch(/lineAdd|lineDel/)
  })

  it('+/− 符号在自己的格里(满饱和色上在它身上,不上在整行文字上)', () => {
    const { container } = draw(parsed())
    const signs = Array.from(container.querySelectorAll('[class*="sign"]')).map((n) => n.textContent)
    expect(signs).toEqual([' ', '−', '+', '+'])
  })

  /*
   * 批 ②:行号**从一列变两列**(旧 / 新),而且它是**数据**不是 DOM 文本 ——
   * 基础件用 `content: attr(data-old-no)` 画,所以框选一段 diff 复制出来一个数字
   * 都没有(与从前 `.num` 那一列靠 `user-select:none` 求来的结果相同,只是这回
   * 是结构上的)。两列同时把「这一行是加是删」说了第二遍:加行没有旧号,删行没有
   * 新号 —— 计数器表达不了这件事,这就是行号走数据的理由。
   */
  const numbersOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-old-no], [data-new-no], [class*="line"]'))
      .filter((el) => el.className.includes('line'))
      .map((el) => [el.getAttribute('data-old-no'), el.getAttribute('data-new-no')])

  it('两列行号:旧号从 oldStart 推、新号从 newStart 推', () => {
    const { container } = draw(parsed())
    // `@@ -10,3 +10,4 @@` → ctx(10/10) · del(11/—) · add(—/11) · add(—/12)
    expect(numbersOf(container)).toEqual([
      ['10', '10'],
      ['11', null],
      [null, '11'],
      [null, '12'],
    ])
  })

  it('新增行不占旧文件的行号,删除行不占新文件的行号', () => {
    const { container } = draw(parsed())
    const rows = Array.from(container.querySelectorAll('[class*="line"]'))
    const add = rows.find((row) => row.textContent?.includes('new line'))!
    const del = rows.find((row) => row.textContent?.includes('old line'))!
    expect(add.hasAttribute('data-old-no')).toBe(false)
    expect(del.hasAttribute('data-new-no')).toBe(false)
  })

  it('碎片 diff 没有起始行号时两列都空着 —— 不编一个,但列仍在', () => {
    const { container } = draw(routeFence('diff', '+a\n-b', true))
    expect(numbersOf(container)).toEqual([
      [null, null],
      [null, null],
    ])
    // 列仍在:两列的宽由基础件的 `numBoth` 档给,根上那个类就是「列在不在」的取件口。
    expect(container.querySelector('pre')?.className).toMatch(/numBoth/)
  })

  it('有文件名就逐行上色,语言由扩展名说;没有文件名就是素文本', async () => {
    const withFile = draw({
      kind: 'diff',
      file: 'src/app.ts',
      source: DIFF,
      ...parsedShape(),
    })
    // 高亮是懒加载的:库到了之后原位重画,所以等那一帧。
    await waitFor(() =>
      expect(withFile.container.querySelectorAll('[class*="line"] span[style]').length).toBe(4),
    )
    // 字一个都没变(上色只是把同一段字包进带色的 span)。
    expect(
      Array.from(withFile.container.querySelectorAll('[class*="line"]')).map((el) => el.textContent),
    ).toEqual([' keep', '−old line', '+new line', '+extra'])

    // markdown 的 ```diff 围栏没有文件名这回事 —— 素文本,零带色 span。
    const noFile = draw(parsed())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(noFile.container.querySelectorAll('[class*="line"] span[style]').length).toBe(0)
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

/** 同一段 diff 的解析结果,只借它的 hunks / stat(给「带文件名」那一格用)。 */
function parsedShape() {
  const block = parsed() as Extract<BlockModel, { kind: 'diff' }>
  return { hunks: block.hunks, stat: block.stat }
}

/**
 * `hunkCodeLines` 是纯函数 —— 两个计数器各走各的那条判据在这里单独钉一遍,
 * 免得它只能靠一整棵 DOM 才验得到。
 */
describe('hunkCodeLines(纯函数)', () => {
  it('两个计数器各走各的:add 不动旧号,del 不动新号', () => {
    const lines = hunkCodeLines({
      oldStart: 10,
      newStart: 20,
      lines: [
        { kind: 'ctx', text: 'a' },
        { kind: 'del', text: 'b' },
        { kind: 'add', text: 'c' },
        { kind: 'ctx', text: 'd' },
      ],
    })
    expect(lines.map((line) => [line.oldNo, line.newNo, line.mark])).toEqual([
      [10, 20, undefined],
      [11, undefined, 'del'],
      [undefined, 21, 'add'],
      [12, 22, undefined],
    ])
  })

  it('起始号缺席 = 那一列整列空着(碎片 diff),token 按下标落到行上', () => {
    const lines = hunkCodeLines(
      { lines: [{ kind: 'add', text: 'x' }, { kind: 'del', text: 'y' }] },
      [[{ content: 'x', color: '#1', offset: 0 }], [{ content: 'y', color: '#2', offset: 0 }]],
    )
    expect(lines.map((line) => [line.oldNo, line.newNo])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ])
    expect(lines.map((line) => line.tokens?.[0]?.content)).toEqual(['x', 'y'])
  })
})
