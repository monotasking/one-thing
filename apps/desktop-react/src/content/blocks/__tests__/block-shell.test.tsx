import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BlockShell } from '../shell/BlockShell'
import { clearBlockLoaderCache } from '../shell/loader'
import { BlockView } from '../BlockView'
import type { BlockCtx, BlockDef } from '../registry'
import type { BlockModel } from '../../model/blocks'
import { __resetLogForTests } from '../../../services/log'
import { dumpCrashes } from '../../../services/crash'
import { useStageStore } from '../../../stage/store'

/**
 * 壳的两条 jsdom 用例(§8:测试面全在纯函数上,jsdom 只留给边界/降级)。
 *
 * React 在边界接住错之后仍会往 console.error 打一整篇,那是 React 自己的行为、
 * 不是被测对象 —— 只在本文件静音,只静 error 这一档(与面板边界那只测试同款)。
 */
let quiet: ReturnType<typeof vi.spyOn>
beforeAll(() => {
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterAll(() => quiet.mockRestore())

beforeEach(() => {
  __resetLogForTests()
  clearBlockLoaderCache()
  useStageStore.setState({ locale: 'zh' })
})

const ctx: BlockCtx = { messageId: 'a1', streaming: false }

/**
 * 闸门由测试开合,不用「第一次渲染抛、之后正常」那种自复位写法:React 19 撞到错
 * 会同步重渲一遍整棵根再决定交不交给边界,自复位组件第二遍就成功了,边界根本不亮。
 */
const gate = { fail: true }

const bomb: BlockDef = {
  kind: 'code',
  presentation: 'object',
  streaming: 'atomic',
  Component: () => {
    if (gate.fail) throw new Error('渲染器炸了')
    return <div data-testid="bomb-ok">画出来了</div>
  },
  chrome: () => ({ id: 'ts' }),
}

const codeModel: BlockModel = {
  kind: 'code',
  lang: 'ts',
  source: 'const answer = 42',
  closed: true,
}

describe('单块错误边界:降级成源码,不是一张错误卡', () => {
  beforeEach(() => {
    gate.fail = true
  })

  it('渲染器抛错 → 原地画源码 + 一行说明', () => {
    render(<BlockShell def={bomb} model={codeModel} ctx={ctx} />)
    expect(screen.getByText('const answer = 42')).toBeTruthy()
    expect(screen.getByText('这块没画出来')).toBeTruthy()
    // 后端/运行时说的那句原话照抄,不改写。
    expect(screen.getByText('渲染器炸了')).toBeTruthy()
  })

  it('炸的是这一块,兄弟块照常画出来', () => {
    render(
      <>
        <BlockShell def={bomb} model={codeModel} ctx={ctx} />
        <BlockView block={{ kind: 'paragraph', inline: [{ type: 'text', text: '我还活着' }] }} ctx={ctx} />
      </>,
    )
    expect(screen.getByText('这块没画出来')).toBeTruthy()
    expect(screen.getByText('我还活着')).toBeTruthy()
  })

  it('记一条崩溃,现场名带上块 kind 与消息 id', () => {
    render(<BlockShell def={bomb} model={codeModel} ctx={ctx} />)
    const crashes = dumpCrashes()
    expect(crashes.length).toBeGreaterThan(0)
    expect(JSON.stringify(crashes)).toContain('block:code@a1')
  })

  it('模型没有 source 字段时,降级画的是模型本身(诚实兜底)', () => {
    render(
      <BlockShell
        def={{ ...bomb, kind: 'table' }}
        model={{ kind: 'table', head: [], rows: [] }}
        ctx={ctx}
      />,
    )
    expect(screen.getByText(/"kind": "table"/)).toBeTruthy()
  })
})

describe('懒加载失败与渲染抛错走同一条降级路', () => {
  it('loader 拒绝 → 源码可见', async () => {
    gate.fail = false
    const def: BlockDef = {
      ...bomb,
      kind: 'figure',
      loader: () => Promise.reject(new Error('拉不到 mermaid')),
    }
    render(<BlockShell def={def} model={codeModel} ctx={ctx} />)
    expect(await screen.findByText('const answer = 42')).toBeTruthy()
    expect(screen.getByText('拉不到 mermaid')).toBeTruthy()
  })
})

describe('檐与动作组', () => {
  beforeEach(() => {
    gate.fail = false
  })

  it('object 块画檐:左端 id + 右端动作;flow 块一个节点都不多加', () => {
    const { container } = render(
      <BlockView
        block={{ kind: 'source-fallback', reason: 'tool-default', source: '{}' }}
        ctx={ctx}
      />,
    )
    expect(screen.getByText('tool-default')).toBeTruthy()
    expect(screen.getByText('复制源码')).toBeTruthy()

    const flow = render(
      <BlockView block={{ kind: 'paragraph', inline: [{ type: 'text', text: '一段字' }] }} ctx={ctx} />,
    )
    // flow 的落点直接就是 <p> —— 壳没有包任何容器(包了会改掉它在 flex 列里的排布)。
    expect(flow.container.firstElementChild?.tagName).toBe('P')
    expect(container.querySelector('[data-block-kind="source-fallback"]')).toBeTruthy()
  })

  it('没有执行器的动词不露出(点了没反应比没这个钮更糟)', () => {
    const def: BlockDef = {
      ...bomb,
      actions: () => [
        { verb: 'copy', what: 'source', text: 'x' },
        { verb: 'download', what: 'png', filename: 'a.png' },
        { verb: 'zoom' },
      ],
    }
    render(<BlockShell def={def} model={codeModel} ctx={ctx} />)
    expect(screen.getByText('复制源码')).toBeTruthy()
    expect(screen.queryByLabelText('更多动作')).toBeNull()
  })

  it('超过两个动作时,第三个起进 ⋯ 菜单', () => {
    const def: BlockDef = {
      ...bomb,
      actions: () => [
        { verb: 'copy', what: 'source', text: 'x' },
        { verb: 'copy', what: 'markdown', text: 'y' },
        { verb: 'copy', what: 'csv', text: 'z' },
      ],
    }
    render(<BlockShell def={def} model={codeModel} ctx={ctx} />)
    expect(screen.queryByText('复制 CSV')).toBeNull()
    fireEvent.click(screen.getByLabelText('更多动作'))
    expect(screen.getByText('复制 CSV')).toBeTruthy()
  })

  it('查看源码是壳自己的状态:点一下换成源码,再点回去', () => {
    const def: BlockDef = { ...bomb, actions: () => [{ verb: 'view-source' }] }
    render(<BlockShell def={def} model={codeModel} ctx={ctx} />)
    expect(screen.getByTestId('bomb-ok')).toBeTruthy()

    fireEvent.click(screen.getByText('查看源码'))
    expect(screen.getByText('const answer = 42')).toBeTruthy()
    expect(screen.queryByTestId('bomb-ok')).toBeNull()

    fireEvent.click(screen.getByText('收起源码'))
    expect(screen.getByTestId('bomb-ok')).toBeTruthy()
  })
})
