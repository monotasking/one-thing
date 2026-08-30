import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { BlockView } from '../../../BlockView'
import type { BlockCtx } from '../../../registry'
import { FigureKindRegistry, clearFigureCacheForTest, renderFigure, resolveFigureKind } from '../registry'
import { resetMermaidForTest } from '../mermaid'
import { useStageStore } from '../../../../../stage/store'

/**
 * 图种二级表 + 图块上屏。
 *
 * mermaid 的**真渲染**在 jsdom 里做不到(它要量文字宽度、要真排版),所以这里把它
 * mock 到边界上:边界 = `import('mermaid')` 这一下。mock 之内是我们的代码
 * (表、缓存、降级、放大、导出),mock 之外是 mermaid 自己的事 —— 那一半的验收在
 * 真机上,不在这里假装。
 */
vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    render: (id: string, source: string) =>
      source.includes('BOOM')
        ? Promise.reject(new Error('Parse error on line 1'))
        : Promise.resolve({
            svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><title>${id}</title></svg>`,
          }),
  },
}))

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  clearFigureCacheForTest()
  resetMermaidForTest()
})

const ctx: BlockCtx = { messageId: 'm1', streaming: false }
const drawFigure = (figKind: string, source: string) =>
  render(<BlockView block={{ kind: 'figure', figKind, source }} ctx={ctx} />)

describe('图种表(与主表同构的第二张表)', () => {
  it('重复注册抛错 —— 不静默后胜', () => {
    const table = new FigureKindRegistry()
    const def = { kind: 'x', render: () => Promise.resolve({ svg: '<svg/>' }) }
    table.register(def)
    expect(() => table.register(def)).toThrow(/重复注册/)
  })

  it('未知图种查不到就是 undefined —— 不是错误', () => {
    expect(new FigureKindRegistry().resolve('nope')).toBeUndefined()
  })

  it('生产那张表上今天只有 mermaid', () => {
    expect(resolveFigureKind('mermaid')).toBeTruthy()
    expect(resolveFigureKind('plantuml')).toBeUndefined()
  })

  it('渲染缓存同源不二渲(第二次不再调 render)', async () => {
    let calls = 0
    const def = {
      kind: 'counting',
      render: () => {
        calls += 1
        return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
      },
    }
    await renderFigure(def, 'same')
    await renderFigure(def, 'same')
    expect(calls).toBe(1)
    await renderFigure(def, 'other')
    expect(calls).toBe(2)
  })

  it('渲染失败也进缓存 —— 同一段画不出来的源码不该反复重试', async () => {
    let calls = 0
    const def = {
      kind: 'always-fails',
      render: () => {
        calls += 1
        return Promise.reject(new Error('画不出来'))
      },
    }
    expect(await renderFigure(def, 's')).toEqual({ status: 'error', message: '画不出来' })
    await renderFigure(def, 's')
    expect(calls).toBe(1)
  })
})

describe('图块上屏', () => {
  it('未知 figKind → 源码可见(不报错、不空白)', async () => {
    const { container } = drawFigure('plantuml', '@startuml\nA -> B\n@enduml')
    await act(async () => undefined)
    expect(container.querySelector('[data-block-kind="figure"]')).toBeTruthy()
    expect(container.textContent).toContain('@startuml')
    expect(container.querySelector('[class*="canvas"]')).toBeNull()
  })

  it('未知 figKind 的檐上显 figKind 本身', async () => {
    const { container } = drawFigure('plantuml', 'A -> B')
    await act(async () => undefined)
    expect(container.querySelector('header')?.textContent).toContain('plantuml')
  })

  it('mermaid 渲好后画 SVG(不经 innerHTML,走 DOMParser)', async () => {
    const { container } = drawFigure('mermaid', 'graph TD\nA-->B')
    await act(async () => undefined)
    expect(container.querySelector('[class*="canvas"] svg')).toBeTruthy()
    // 渲好之后源码就不该再占屏了 —— 源码是降级态,不是常驻。
    expect(container.querySelector('pre')).toBeNull()
  })

  it('檐上的类型词取 mermaid 自己的图种(认不出才显 mermaid)', async () => {
    const flow = drawFigure('mermaid', 'graph TD\nA-->B')
    await act(async () => undefined)
    expect(flow.container.querySelector('header')?.textContent).toContain('flowchart')

    const odd = drawFigure('mermaid', '%% 注释\n没见过的写法')
    await act(async () => undefined)
    expect(odd.container.querySelector('header')?.textContent).toContain('mermaid')
  })

  it('檐上三个动作:放大常显,下载 PNG 与查看源码收进 ⋯', async () => {
    drawFigure('mermaid', 'graph TD\nA-->B')
    await act(async () => undefined)
    expect(screen.getByText('放大')).toBeTruthy()
    // frontActions:1 —— 另外两个不在檐上,要开 ⋯ 才有。
    expect(screen.queryByText('下载 PNG')).toBeNull()
    fireEvent.click(screen.getByLabelText('更多动作'))
    expect(screen.getByText('下载 PNG')).toBeTruthy()
    expect(screen.getByText('查看源码')).toBeTruthy()
  })

  it('放大开一个浮层,Esc 关掉', async () => {
    drawFigure('mermaid', 'graph TD\nA-->B')
    await act(async () => undefined)
    fireEvent.click(screen.getByText('放大'))
    await act(async () => undefined)
    expect(screen.getByTestId('block-zoom-scrim')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('block-zoom-scrim')).toBeNull()
  })

  it('渲染失败 → 源码可见 + 一行说明(灰,不是 danger 大字),原话不改写', async () => {
    const { container } = drawFigure('mermaid', 'graph TD\nBOOM')
    await act(async () => undefined)
    expect(screen.getByText('这张图没画出来')).toBeTruthy()
    expect(container.textContent).toContain('Parse error on line 1')
    expect(container.textContent).toContain('BOOM')
    expect(container.querySelector('[class*="canvas"]')).toBeNull()
  })

  it('还没渲好时点放大不开空浮层 —— 取件口取不到就什么都不做', () => {
    drawFigure('mermaid', 'graph TD\nA-->B')
    fireEvent.click(screen.getByText('放大'))
    expect(screen.queryByTestId('block-zoom-scrim')).toBeNull()
  })
})
