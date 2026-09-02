import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BlockShell } from '../shell/BlockShell'
import shellStyles from '../shell/BlockShell.module.css'
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
  stream: { midway: 'hold', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
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

/*
 * 折叠态**不许成为纵向滚动容器**(08-30 用户报「滚轮进块就滚不动页面」)。
 *
 * 这一条只能在 CSS 文本上断言:jsdom 不排版、CSS Modules 在测试里也只剩类名映射,
 * 「滚轮到底传不传出去」在这层根本量不到(真机那半边由 CDP mouseWheel 收)。
 * 所以判据落在源文件的两个字面事实上,把病历钉死成机器守得住的东西。
 */
describe('块体的滚动契约', () => {
  // vitest 的 cwd 就是这个应用的根(import.meta.url 在 vite 变换后不是 file: 协议)。
  const css = readFileSync(
    resolve(process.cwd(), 'src/content/blocks/shell/BlockShell.module.css'),
    'utf8',
  )
  // 注释里出现的 overscroll-behavior 不算数,只看真正的声明行。
  const declarations = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())

  it('overscroll 只锁横轴:没有裸的双轴简写', () => {
    expect(declarations.filter((line) => /^overscroll-behavior\s*:/.test(line))).toEqual([])
    expect(declarations).toContain('overscroll-behavior-x: contain;')
  })

  it('纵向显式 hidden:横滚的 auto 不许把另一轴带成 auto', () => {
    expect(declarations).toContain('overflow-x: auto;')
    expect(declarations).toContain('overflow-y: hidden;')
  })

  /*
   * 渐隐遮罩的**唯一产地**是 `.bodyClamped`(09-02 用户报「代码块最后一行有一层雾」)。
   * 从前它无条件写在 `.body` 上,而 `max-height` 是上限不是定高 —— 一行的 bash 块
   * 从来没被裁过一个像素,却照样把唯一那一行的下缘淡掉,屏幕上说了一件不存在的事。
   * 这一条与上面两条同理只能落在 CSS 文本上:哪个类挂了 mask 是这份文件的字面事实。
   */
  it('遮罩只长在 .bodyClamped 上:.body 与 .bodyExpanded 一句都没有', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const at = (selector: string) => rules.indexOf(selector)
    const slice = (from: string, to: string) => rules.slice(at(from), at(to))
    expect(slice('.body {', '.bodyClamped {')).not.toContain('mask-image')
    expect(slice('.bodyClamped {', '.bodyExpanded {')).toContain('mask-image: linear-gradient(')
    expect(rules.slice(at('.bodyExpanded {')).split('}')[0]).not.toContain('mask-image')
  })
})

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

/**
 * 渐隐遮罩与展开钮是**同一格 `overflows`** 的两个出口(09-02 报障「代码块最后一行
 * 有一层雾」)。它们说的本来就是同一句话「下面还有」,分成两个判据就会出现
 * 「雾着却没有钮」—— 那正是这条报障的形。
 *
 * jsdom 不排版(`scrollHeight` / `clientHeight` 恒 0),所以「超高」这一档要把浏览器
 * 该给的那两个读数按在原型上假一次。假的**只有那两个数**:判据
 * (`scrollHeight > clientHeight + 1`)与类名怎么挂全是被测代码自己的。
 * 短块那一档不必假 —— jsdom 的 0 = 0 正是「一行的 bash 块」。
 */
describe('限高折叠:雾只在真被裁断时挂', () => {
  const bodyOf = (container: HTMLElement) =>
    container.querySelector(`.${shellStyles.body}`) as HTMLElement

  /** 假两个读数,交回一口还原 —— 原型上的改动必须在同一个 it 里收干净。 */
  function fakeHeights(scrollHeight: number, clientHeight: number): () => void {
    const proto = window.HTMLElement.prototype
    const before = {
      scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
      clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
    }
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => clientHeight })
    return () => {
      if (before.scrollHeight) Object.defineProperty(proto, 'scrollHeight', before.scrollHeight)
      if (before.clientHeight) Object.defineProperty(proto, 'clientHeight', before.clientHeight)
    }
  }

  beforeEach(() => {
    gate.fail = false
  })

  it('没裁到的短块:不挂遮罩类,也没有展开钮', () => {
    // 先证明那个类**存在** —— 类名没了的话下面那句 `contains(undefined)` 恒假,
    // 断言会在遮罩搬回 `.body` 的世界里照样绿(反证时实测过)。
    expect(typeof shellStyles.bodyClamped).toBe('string')
    const { container } = render(<BlockShell def={bomb} model={codeModel} ctx={ctx} />)
    const body = bodyOf(container)
    expect(body.classList.contains(shellStyles.body)).toBe(true)
    expect(body.classList.contains(shellStyles.bodyClamped)).toBe(false)
    expect(screen.queryByText('展开')).toBeNull()
  })

  it('被裁断的高块:挂遮罩类 + 出展开钮;展开之后遮罩撤掉', () => {
    const restore = fakeHeights(400, 320)
    try {
      const { container } = render(<BlockShell def={bomb} model={codeModel} ctx={ctx} />)
      expect(bodyOf(container).classList.contains(shellStyles.bodyClamped)).toBe(true)

      fireEvent.click(screen.getByText('展开'))
      const expanded = bodyOf(container)
      expect(expanded.classList.contains(shellStyles.bodyExpanded)).toBe(true)
      expect(expanded.classList.contains(shellStyles.bodyClamped)).toBe(false)
    } finally {
      restore()
    }
  })
})
