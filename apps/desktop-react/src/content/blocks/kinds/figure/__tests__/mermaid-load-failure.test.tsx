import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { BlockView } from '../../../BlockView'
import type { BlockCtx } from '../../../registry'
import { clearFigureCacheForTest } from '../registry'
import { resetMermaidForTest } from '../mermaid'
import { useStageStore } from '../../../../../stage/store'

/**
 * 库拉不到时的降级 —— **自成一个文件**。
 *
 * 「拉得到」和「拉不到」是同一个模块 id 的两种 mock,一个进程里立不住两份,所以
 * 成功路在 figure.test.tsx,失败路在这里。这条路值得单测:懒加载的失败是生产里
 * 真会发生的一件事(离线首开、chunk 被 CDN 掐、版本错位),而它的正确表现不是
 * 白屏,也不是红字 —— 是那段图源码照常在。
 */
vi.mock('mermaid', async () => {
  throw new Error('Failed to fetch dynamically imported module')
})

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  clearFigureCacheForTest()
  resetMermaidForTest()
})

const ctx: BlockCtx = { messageId: 'm1', streaming: false }

describe('mermaid 拉不到', () => {
  it('降级到源码可见 + 一行说明,说的是运行时的原话', async () => {
    const { container } = render(
      <BlockView block={{ kind: 'figure', figKind: 'mermaid', source: 'graph TD\nA-->B' }} ctx={ctx} />,
    )
    await act(async () => undefined)
    expect(screen.getByText('这张图没画出来')).toBeTruthy()
    // 原话不改写 —— 这里不比对具体那句话(它是运行时/打包器的措辞,vitest 的假
    // import 还会在外面再套一层),只钉住「原话确实被转出来了」这件事。
    expect(container.querySelector('[class*="failureReason"]')?.textContent).toBeTruthy()
    // 图源码一个字不少 —— 全系统同一条失败语义。
    expect(container.textContent).toContain('graph TD')
    expect(container.querySelector('[class*="canvas"]')).toBeNull()
  })

  it('拉失败不记账:下一张图会再试一次(一次抖动不该让这台永远没有图)', async () => {
    render(<BlockView block={{ kind: 'figure', figKind: 'mermaid', source: 'graph TD\nA' }} ctx={ctx} />)
    await act(async () => undefined)

    // 换一段源码 = 换一个缓存键。若 loader 把失败记住了,这一张会静默不再尝试,
    // 屏幕上就只剩一张没有说明的源码 —— 那才是「永远没有图」的样子。
    render(<BlockView block={{ kind: 'figure', figKind: 'mermaid', source: 'graph TD\nB' }} ctx={ctx} />)
    await act(async () => undefined)

    expect(screen.getAllByText('这张图没画出来')).toHaveLength(2)
  })
})
