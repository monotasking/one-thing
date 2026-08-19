// @vitest-environment happy-dom
/**
 * `DiffView` 的组件级测试 —— 不是 `diff-hunks` 那份纯函数测试的重复。
 *
 * 真正画字的是 `@pierre/diffs`(自带 shadow DOM),所以这里把它换成一个**记事本
 * 替身**:它把每次拿到的 options / fileDiff 记下来,并按 fileDiff 画出行来。
 * 于是可以断言 DiffView 交给库的那份契约 —— 行数、split/unified、文件头、
 * 展开上下文 —— 以及它自己那几个状态(loading / error / 空)。
 *
 * 最后一条是**回归守卫**:行号一度是 `position: sticky`,一个 400 行的写入面板
 * 因此带来 400 个合成层,页面上任何一处动画都要为它付 40–100ms 的分层开销
 * (2026-08-19 实测)。注入的 CSS 必须把它按回 static。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffHunk } from '@/types'

interface RenderCall {
  options: Record<string, unknown>
  fileDiff: { name: string; hunks: unknown[]; splitLineCount: number; unifiedLineCount: number }
  oldFile?: { contents: string }
  newFile?: { contents: string }
}

const renderCalls: RenderCall[] = []
let cleanUpCount = 0

vi.mock('@pierre/diffs', () => {
  class FakeFileDiff {
    constructor(private readonly options: Record<string, unknown>) {}

    render(args: { fileDiff: RenderCall['fileDiff']; containerWrapper: HTMLElement; oldFile?: { contents: string }; newFile?: { contents: string } }) {
      renderCalls.push({
        options: this.options,
        fileDiff: args.fileDiff,
        oldFile: args.oldFile,
        newFile: args.newFile,
      })
      // 替身按 fileDiff 画行,让「行数」这件事在 DOM 上可数。
      const container = document.createElement('div')
      container.className = 'diffs-container'
      const rows = this.options.diffStyle === 'split'
        ? args.fileDiff.splitLineCount
        : args.fileDiff.unifiedLineCount
      for (let i = 0; i < rows; i++) {
        const line = document.createElement('div')
        line.className = 'diffs-line'
        container.appendChild(line)
      }
      const renderHeader = this.options.renderHeaderMetadata as
        | ((props: { fileDiff: unknown }) => HTMLElement)
        | undefined
      if (renderHeader) container.appendChild(renderHeader({ fileDiff: args.fileDiff }))
      args.containerWrapper.appendChild(container)
    }

    cleanUp() { cleanUpCount++ }
    setThemeType() {}
  }
  return { FileDiff: FakeFileDiff, registerCustomTheme: () => {} }
})

// 一个改动块:2 行上下文 + 1 删 1 增 → unified 4 行,split 3 行。
const HUNKS: DiffHunk[] = [
  {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [
      { op: 'ctx', text: 'const a = 1' },
      { op: 'del', text: 'const b = 2' },
      { op: 'add', text: 'const b = 3' },
      { op: 'ctx', text: 'export { a, b }' },
    ],
  },
]

async function mountDiff(props: Record<string, unknown> = {}) {
  const DiffView = (await import('../DiffView.vue')).default
  const wrapper = mount(DiffView, { props: { hunks: HUNKS, ...props }, attachTo: document.body })
  await nextTick()
  await nextTick()
  return wrapper
}

const lastCall = () => renderCalls[renderCalls.length - 1]

beforeEach(() => {
  renderCalls.length = 0
  cleanUpCount = 0
  document.body.innerHTML = ''
})

describe('DiffView', () => {
  it('把 hunks 变成库要的 fileDiff:行数由 hunk 内容算出来', async () => {
    const w = await mountDiff({ diffStyle: 'unified' })
    expect(renderCalls).toHaveLength(1)
    const { fileDiff } = lastCall()
    expect(fileDiff.hunks).toHaveLength(1)
    expect(fileDiff.unifiedLineCount).toBe(4) // 2 上下文 + 1 删 + 1 增
    expect(fileDiff.splitLineCount).toBe(3)   // 删/增并排占一行
    expect(w.findAll('.diffs-line')).toHaveLength(4)
  })

  it('split / unified 可切换:重画一次,口径与行数都跟着变', async () => {
    // 文件头关掉时工具条才在场,切换按钮就在工具条上。
    const w = await mountDiff({ showFileHeader: false, diffStyle: 'split' })
    expect(lastCall().options.diffStyle).toBe('split')
    expect(w.findAll('.diffs-line')).toHaveLength(3)
    expect(w.find('.toolbar-btn').text()).toBe('Split')

    await w.find('.toolbar-btn').trigger('click')
    await nextTick()
    expect(lastCall().options.diffStyle).toBe('unified')
    expect(w.find('.toolbar-btn').text()).toBe('Unified')
    // 旧实例被回收,不是两份叠着画。
    expect(cleanUpCount).toBeGreaterThan(0)
    expect(w.findAll('.diffs-line')).toHaveLength(4)
  })

  it('外部改 diffStyle 也生效', async () => {
    const w = await mountDiff({ diffStyle: 'split' })
    await w.setProps({ diffStyle: 'unified' })
    await nextTick()
    await nextTick()
    expect(lastCall().options.diffStyle).toBe('unified')
  })

  it('showFileHeader:开着由库画头(顺带吃掉工具条),关着才有自带工具条', async () => {
    const withHeader = await mountDiff({ showFileHeader: true, fileName: 'src/app.ts' })
    expect(withHeader.find('.diff-toolbar').exists()).toBe(false)
    expect(lastCall().options.disableFileHeader).toBe(false)
    // 头部内容由 DiffView 自己渲染:文件名 + 增删统计。
    expect(withHeader.find('.diff-header-name').text()).toBe('src/app.ts')
    expect(withHeader.find('.diff-stat-additions').text()).toBe('+3')
    expect(withHeader.find('.diff-stat-deletions').text()).toBe('-3')

    const noHeader = await mountDiff({ showFileHeader: false })
    expect(noHeader.find('.diff-toolbar').exists()).toBe(true)
    expect(lastCall().options.disableFileHeader).toBe(true)
    expect(lastCall().options.renderHeaderMetadata).toBeUndefined()
  })

  it('showFileName=false 时头里只留统计,不留文件名', async () => {
    const w = await mountDiff({ showFileHeader: true, fileName: 'src/app.ts', showFileName: false })
    expect(w.find('.diff-header-file').exists()).toBe(false)
    expect(w.find('.diff-header-stats').exists()).toBe(true)
  })

  it('expandUnchanged:开关与上下文行数透传,给了新旧全文才把它们交给库', async () => {
    const off = await mountDiff({ expandUnchanged: false })
    expect(off.exists()).toBe(true)
    expect(lastCall().options.expandUnchanged).toBe(false)
    expect(lastCall().oldFile).toBeUndefined()

    await mountDiff({ expandUnchanged: true, expansionLineCount: 9, oldContent: 'a\n', newContent: 'b\n' })
    expect(lastCall().options.expandUnchanged).toBe(true)
    expect(lastCall().options.expansionLineCount).toBe(9)
    expect(lastCall().oldFile?.contents).toBe('a\n')
    expect(lastCall().newFile?.contents).toBe('b\n')
  })

  it('loading / error / 空 diff 各自出自己的态,且都不去画 diff', async () => {
    const loading = await mountDiff({ loading: true })
    expect(loading.find('.diff-loading').exists()).toBe(true)
    expect(renderCalls).toHaveLength(0)

    const errored = await mountDiff({ hunks: [], error: '读文件失败' })
    expect(errored.find('.diff-error').text()).toBe('读文件失败')
    expect(renderCalls).toHaveLength(0)

    const empty = await mountDiff({ hunks: [], diff: '' })
    expect(empty.find('.diff-empty').text()).toBe('No changes')
    expect(renderCalls).toHaveLength(0)
  })

  it('行号不是 sticky —— 每个 sticky 框都是一个合成层,长 diff 会把整页拖垮', async () => {
    await mountDiff()
    // 注释里正解释着「库那边是 sticky」,所以先把注释剥掉再看声明。
    const css = String(lastCall().options.unsafeCSS).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toContain('[data-column-number]')
    expect(css).toMatch(/\[data-column-number\]\s*\{\s*position:\s*static/)
    expect(css).not.toMatch(/position:\s*sticky/)
  })
})
