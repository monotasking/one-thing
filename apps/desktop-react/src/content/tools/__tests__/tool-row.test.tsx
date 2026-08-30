import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import type { BlockCtx } from '../../blocks/registry'
import type { ProjectedToolCall, ToolStepModel } from '../../model/segments'
import { presentToolStep } from '../../assemble/present'
import { ToolRow } from '../ToolRow'

/**
 * A1 卡行 + V2 三态 + C1 抽屉的上屏测(jsdom 只用在这一格:状态标记与热区)。
 *
 * 三件事在这一层才测得到:
 *  ① **三态标记真的落到 DOM 上**(颜色是 CSS 的事,但「这一行是哪一态」是组件的判断);
 *  ② **能不能展开**这条闸(运行中的行不许拉开 —— 详情还在长);
 *  ③ **抽屉里的结果真的走块注册表** —— 这是「一张注册表,两个产地」那条铁律的
 *     唯一可机检点:断言抽屉里长出来的是 `data-block-kind="code"` 的那个组件,
 *     而不是抽屉自己画的一段 pre。
 */

// shiki 是异步的,而这里断言的是素文本先行 —— 与 kinds 冒烟同一条。
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

function step(patch: Record<string, unknown> = {}): ToolStepModel {
  return presentToolStep({
    id: 'c1',
    toolId: 'read',
    toolName: 'read',
    arguments: { path: '/repo/a.ts' },
    status: 'completed',
    timestamp: T0,
    ...patch,
  } as unknown as ProjectedToolCall)
}

async function draw(patch: Record<string, unknown> = {}) {
  const view = render(<ToolRow step={step(patch)} ctx={ctx} />)
  // 代码块的懒加载闸是异步的;等它落定再断言,免得 act 警告淹掉真信号。
  await act(async () => undefined)
  return view
}

const card = (container: HTMLElement) => container.querySelector('[data-tool-status]') as HTMLElement

describe('V2:状态长在图标上,不长成一个词', () => {
  it('成功 = ok 态,右端是成果词,没有「已完成」这类打卡词', async () => {
    const { container } = await draw({ result: { details: { lineCount: 42 } } })
    expect(card(container).getAttribute('data-tool-tone')).toBe('ok')
    expect(container.textContent).toContain('42 行')
    expect(container.textContent).not.toContain('已完成')
  })

  it('失败 = bad 态,右端是后端说的那句原话', async () => {
    const { container } = await draw({ status: 'failed', error: 'ENOENT: 没有这个文件' })
    expect(card(container).getAttribute('data-tool-tone')).toBe('bad')
    expect(container.textContent).toContain('ENOENT: 没有这个文件')
  })

  it('运行中 = busy 态,右端一枚 spinner + 那一档状态', async () => {
    const { container } = await draw({ status: 'executing' })
    expect(card(container).getAttribute('data-tool-tone')).toBe('busy')
    expect(container.textContent).toContain('执行中')
    // spinner 是装饰性的(没有 label),所以按 aria-hidden 找而不是按 role。
    expect(container.querySelector('[aria-hidden="true"][class*="ring"]')).toBeTruthy()
  })

  it('认不出的状态既不猜是哪一态,也不吞掉那个枚举', async () => {
    const { container } = await draw({ status: 'teleported' })
    expect(card(container).getAttribute('data-tool-tone')).toBe('unknown')
    expect(container.textContent).toContain('teleported')
  })

  it('成果词与耗时都缺席时右端就是空的 —— 宁可空着,不拿一句话去填', async () => {
    const { container } = await draw({})
    expect(container.textContent).toBe('a.ts')
  })

  it('呼吸的降级写在样式里:reduced-motion 下停在常亮,不是关掉反馈', () => {
    // jsdom 不排版、不求值媒体查询,所以这一条只能对**样式源**断言 —— 它仍然是
    // 机器判据(改坏了当场红),比走查清单硬。
    const css = readFileSync(resolve(process.cwd(), 'src/content/tools/ToolRow.module.css'), 'utf-8')
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toContain("[data-tool-tone='busy'] .toolIcon")
    expect(block).toContain('animation: none')
    expect(block).toContain('opacity: 1')
  })
})

describe('C1 抽屉:行下原位下拉', () => {
  it('收场了的行点开是参数 + 结果两节', async () => {
    const { container } = await draw({ result: { content: [{ type: 'text', text: 'const a = 1' }] } })
    expect(screen.queryByText('参数')).toBeNull()

    await act(async () => {
      fireEvent.click(container.querySelector('button')!)
    })
    expect(screen.getByText('参数')).toBeTruthy()
    expect(screen.getByText('结果')).toBeTruthy()
    // 参数是紧凑键值,不是一坨 JSON。(路径在屏幕上出现两次 —— 参数一次、代码块
    // 檐上的文件名位一次 —— 所以按 dt/dd 那一对找,不按全局文本找。)
    const name = screen.getByText('path')
    expect(name.tagName).toBe('DT')
    expect(name.nextElementSibling?.textContent).toBe('/repo/a.ts')
  })

  it('结果那一节**真的走块注册表** —— 长出来的是 code 块,不是抽屉自画的 pre', async () => {
    const { container } = await draw({ result: { content: [{ type: 'text', text: 'const a = 1' }] } })
    await act(async () => {
      fireEvent.click(container.querySelector('button')!)
    })
    const block = container.querySelector('[data-block-kind="code"]')
    expect(block).toBeTruthy()
    expect(block?.querySelector('pre')?.textContent).toContain('const a = 1')
    // 檐上那两格是块壳画的(语言 + 文件名位)—— 证明它走的是同一条壳,不是复制的。
    expect(block?.textContent).toContain('typescript')
    expect(block?.textContent).toContain('/repo/a.ts')
  })

  it('再点一下收回去', async () => {
    const { container } = await draw({ result: 'x' })
    const head = container.querySelector('button')!
    await act(async () => fireEvent.click(head))
    expect(screen.getByText('结果')).toBeTruthy()
    await act(async () => fireEvent.click(head))
    expect(screen.queryByText('结果')).toBeNull()
  })

  it('没有结果时说出来,不留一块空白', async () => {
    const { container } = await draw({ toolName: 'bash', toolId: 'bash', arguments: { command: 'ls' } })
    await act(async () => fireEvent.click(container.querySelector('button')!))
    expect(screen.getByText('这次调用没有留下结果')).toBeTruthy()
  })

  it('运行中的行不画按钮 —— 一个按得动却什么也不发生的钮比没有钮更费人', async () => {
    const { container } = await draw({ status: 'executing' })
    expect(container.querySelector('button')).toBeNull()
  })
})
