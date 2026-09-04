import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import type { BlockCtx } from '../../blocks/registry'
import type { ProjectedToolCall } from '../../model/segments'
import { presentToolCard } from '../../assemble/present'
import { ToolCard } from '../ToolCard'

/**
 * 工具卡的上屏测(C2-a)。**两份旧测并成一份** —— `tool-row.test.tsx`(A1 卡行 +
 * V2 三态 + C1 抽屉)与 `tool-group.test.tsx`(计数句 ↔ 执行清单),因为 §6.1 之后
 * 它们画的本来就是同一张卡:分成两份测等于承认还有两种画法。
 *
 * 这一层测得到、纯函数层测不到的四件事:
 *  ① **三态标记真的落到 DOM 上**(颜色是 CSS 的事,「这一行是哪一态」是组件的判断);
 *  ② **能不能展开**这条闸(参数生成中的行不许拉开 —— 那一刻连参数都摆不出来);
 *  ③ **抽屉里的结果真的走块注册表** —— 「一张注册表,两个产地」那条铁律的唯一
 *     可机检点:断言抽屉里长出来的是 `data-block-kind="code"` 的那个组件;
 *  ④ **§6.5 的稳定性纪律**:同一 callId 的行在三次换挡前后是**同一个 DOM 节点**、
 *     收起态活槽位不空、快步骤不露 busy 形、静默读数按秒走。
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

afterEach(() => {
  vi.useRealTimers()
})

function call(
  id: string,
  toolName = 'read',
  patch: Record<string, unknown> = {},
): ProjectedToolCall {
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
  const view = render(<ToolCard card={presentToolCard(calls)} ctx={ctx} />)
  // 代码块的懒加载闸是异步的;等它落定再断言,免得 act 警告淹掉真信号。
  await act(async () => undefined)
  return view
}

const open = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element)
  })
}

/** 一行 = 带 `data-call-id` 的那个元素(button 或 div,取决于能不能展开)。 */
const rowOf = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-call-id="${id}"]`) as HTMLElement

/** 看得见的行(藏起来的行**仍然在树上** —— 那正是零重挂靠的东西)。 */
const visibleRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-call-id]')).filter(
    (row) => !row.hasAttribute('hidden'),
  )

const headOf = (container: HTMLElement) =>
  container.querySelector('[data-tool-head]') as HTMLElement | null

/* ═══ 一步的卡:与从前那张单发卡逐条相同 ═══════════════════════════════ */

describe('V2:状态长在图标上,不长成一个词', () => {
  const single = (patch: Record<string, unknown> = {}) =>
    draw([call('c1', 'read', { arguments: { path: '/repo/a.ts' }, ...patch })])

  it('一步的卡里只有那一行,没有头行', async () => {
    const { container } = await single({ result: { details: { lineCount: 42 } } })
    expect(headOf(container)).toBeNull()
    expect(visibleRows(container)).toHaveLength(1)
  })

  it('成功 = ok 态,右端是成果词,没有「已完成」这类打卡词', async () => {
    const { container } = await single({ result: { details: { lineCount: 42 } } })
    expect(rowOf(container, 'c1').getAttribute('data-tool-tone')).toBe('ok')
    expect(container.textContent).toContain('42 行')
    expect(container.textContent).not.toContain('已完成')
  })

  it('失败 = bad 态,右端是后端说的那句原话', async () => {
    const { container } = await single({ status: 'failed', error: 'ENOENT: 没有这个文件' })
    expect(rowOf(container, 'c1').getAttribute('data-tool-tone')).toBe('bad')
    expect(container.textContent).toContain('ENOENT: 没有这个文件')
  })

  /**
   * 09-02 批 6:**右端那枚 spinner 退役**(Spinner 只许出现在按钮内或状态栏,
   * 而这是长在聊天正文流里的一行)。断言反过来钉住它不许回来。
   *
   * C2-a 又改了右端说什么:那句不变的「执行中」退役,换成**活的耗时**(§6.2)——
   * 一个在数据停了之后一个字都不变的词,正是用户报的「不知道它是不是卡住了」。
   */
  it('运行中 = busy 态,右端是**活的耗时**而不是「执行中」,**不转圈**', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 1_400)
    const { container } = await single({ status: 'executing', startTime: T0 })
    expect(rowOf(container, 'c1').getAttribute('data-tool-tone')).toBe('busy')
    expect(container.textContent).toContain('1.4s')
    expect(container.textContent).not.toContain('执行中')
    // ui/Spinner 的环那一格带 class *ring*(装饰性、无 label)—— 一颗都不许有。
    expect(container.querySelector('[aria-hidden="true"][class*="ring"]')).toBeNull()
  })

  it('认不出的状态既不猜是哪一态,也不吞掉那个枚举', async () => {
    const { container } = await single({ status: 'teleported' })
    expect(rowOf(container, 'c1').getAttribute('data-tool-tone')).toBe('unknown')
    expect(container.textContent).toContain('teleported')
  })

  it('成果词与耗时都缺席时右端就是空的 —— 宁可空着,不拿一句话去填', async () => {
    const { container } = await single()
    expect(container.textContent).toBe('a.ts')
  })

  it('呼吸的降级写在样式里:reduced-motion 下停在常亮,不是关掉反馈', () => {
    // jsdom 不排版、不求值媒体查询,所以这一条只能对**样式源**断言 —— 它仍然是
    // 机器判据(改坏了当场红),比走查清单硬。
    const css = readFileSync(resolve(process.cwd(), 'src/content/tools/ToolCard.module.css'), 'utf-8')
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toContain("[data-tool-tone='busy'] > .toolIcon")
    expect(block).toContain('animation: none')
    expect(block).toContain('opacity: 1')
  })
})

describe('C1 抽屉:行下原位下拉', () => {
  const single = (patch: Record<string, unknown> = {}) =>
    draw([call('c1', 'read', { arguments: { path: '/repo/a.ts' }, ...patch })])

  it('收场了的行点开是参数 + 结果两节', async () => {
    const { container } = await single({ result: { content: [{ type: 'text', text: 'const a = 1' }] } })
    expect(screen.queryByText('参数')).toBeNull()

    await open(rowOf(container, 'c1'))
    expect(screen.getByText('参数')).toBeTruthy()
    expect(screen.getByText('结果')).toBeTruthy()
    // 参数是紧凑键值,不是一坨 JSON。(路径在屏幕上出现两次 —— 参数一次、代码块
    // 檐上的文件名位一次 —— 所以按 dt/dd 那一对找,不按全局文本找。)
    const name = screen.getByText('path')
    expect(name.tagName).toBe('DT')
    expect(name.nextElementSibling?.textContent).toBe('/repo/a.ts')
  })

  it('结果那一节**真的走块注册表** —— 长出来的是 code 块,不是抽屉自画的 pre', async () => {
    const { container } = await single({ result: { content: [{ type: 'text', text: 'const a = 1' }] } })
    await open(rowOf(container, 'c1'))
    const block = container.querySelector('[data-block-kind="code"]')
    expect(block).toBeTruthy()
    expect(block?.querySelector('pre')?.textContent).toContain('const a = 1')
    // 檐上那两格是块壳画的(语言 + 文件名位)—— 证明它走的是同一条壳,不是复制的。
    expect(block?.textContent).toContain('typescript')
    expect(block?.textContent).toContain('/repo/a.ts')
  })

  it('再点一下收回去', async () => {
    const { container } = await single({ result: 'x' })
    const row = rowOf(container, 'c1')
    await open(row)
    expect(screen.getByText('结果')).toBeTruthy()
    await open(row)
    expect(screen.queryByText('结果')).toBeNull()
  })

  it('没有结果时说出来,不留一块空白', async () => {
    const { container } = await draw([
      call('c1', 'bash', { arguments: { command: 'ls' } }),
    ])
    await open(rowOf(container, 'c1'))
    expect(screen.getByText('这次调用没有留下结果')).toBeTruthy()
  })

  /**
   * 拍点 ⑩:**执行中的行也能展开**(§6.2)。空态那句话跟着换 ——
   * 对一条正在跑的调用说「没有留下结果」是说错,不是说少。
   */
  it('执行中的行能展开,空态说的是「还没有输出」', async () => {
    const { container } = await draw([call('c1', 'bash', { status: 'executing', startTime: T0 })])
    const row = rowOf(container, 'c1')
    expect(row.tagName).toBe('BUTTON')
    await open(row)
    expect(screen.getByText('还没有输出')).toBeTruthy()
    expect(screen.queryByText('这次调用没有留下结果')).toBeNull()
  })

  it('参数生成中的行不画按钮 —— 那一刻连一份参数都摆不出来', async () => {
    const { container } = await draw([
      call('c1', 'bash', { status: 'input-streaming', arguments: {}, streamingArgs: '{"comm' }),
    ])
    expect(rowOf(container, 'c1').tagName).toBe('DIV')
    expect(container.querySelector('button')).toBeNull()
  })
})

/* ═══ 多步的卡:头行 + 活槽位 + 展开清单 ═══════════════════════════════ */

describe('多步:头行说的是这几步本身,不是一句计数旁白', () => {
  it('头行 = 摘要句 + 右端总耗时,收起时清单不在场', async () => {
    const { container } = await draw([
      call('c1', 'read', { durationMs: 120 }),
      call('c2', 'bash', { durationMs: 380 }),
    ])
    const head = headOf(container)!
    // 计数句「执行了 N 步」退役:头行画的是这几步的名。
    expect(head.textContent).not.toContain('执行了')
    // bash 那一格念命令首词(headLabel 自述),不念「bash cmd」。
    expect(head.textContent).toContain('read c1.ts · cmd')
    // 总耗时 = 各次之和,走 §5.7 的唯一产地(只到 0.1s,永不写毫秒)。
    expect(head.textContent).toContain('0.5s')
    // 收起时只看得见活槽位那一行(最近收场的那一步)。
    expect(visibleRows(container)).toHaveLength(1)
  })

  it('过了一分钟换成分秒说 —— 「1m 05s」比「65.0s」读得快', async () => {
    const { container } = await draw([
      call('c1', 'read', { durationMs: 65_000 }),
      call('c2', 'bash', { durationMs: 0 }),
    ])
    expect(headOf(container)!.textContent).toContain('1m 05s')
  })

  it('超过三格折成「+N」—— 列到第四个名字人就开始数了', async () => {
    const { container } = await draw([
      call('c1', 'read'),
      call('c2', 'edit'),
      call('c3', 'bash'),
      call('c4', 'write'),
      call('c5', 'grep'),
    ])
    const head = headOf(container)!
    expect(head.textContent).toContain('+2')
    expect(head.textContent).not.toContain('grep')
  })

  it('有失败就在头行右端亮一句红', async () => {
    const { container } = await draw([
      call('c1'),
      call('c2', 'read', { status: 'failed', error: '炸了' }),
    ])
    expect(headOf(container)!.textContent).toContain('1 失败')
  })

  it('图标叠按**工具种类**去重,最多三枚', async () => {
    const { container } = await draw([
      call('c1', 'read'),
      call('c2', 'read'),
      call('c3', 'bash'),
    ])
    const stack = headOf(container)!.firstElementChild!.nextElementSibling!
    expect(stack.childElementCount).toBe(2)
  })
})

describe('展开 = 全部步,按时间序', () => {
  it('点开成清单,每一格一行', async () => {
    const { container } = await draw([call('c1', 'read'), call('c2', 'bash')])
    await open(headOf(container)!)
    expect(visibleRows(container)).toHaveLength(2)
    expect(container.textContent).toContain('c1.ts')
    expect(container.textContent).toContain('cmd')
  })

  it('同名连发在清单里是一行「×N」,点开才逐条', async () => {
    const { container } = await draw([call('c1'), call('c2'), call('c3')])
    await open(headOf(container)!)
    expect(visibleRows(container)).toHaveLength(0)
    const aggregate = container.querySelector('[data-tool-aggregate]') as HTMLElement
    expect(aggregate.hasAttribute('hidden')).toBe(false)
    expect(aggregate.textContent).toContain('×3')

    await open(aggregate)
    expect(visibleRows(container).map((row) => row.getAttribute('data-call-id'))).toEqual([
      'c1',
      'c2',
      'c3',
    ])
  })

  /**
   * 拍点 ⑨:**失败不置顶**。从前展开一个聚合格会把出事的那条提到第一行;
   * 09-05 撤掉 —— 顺序是这张卡唯一的结构,重排等于把「先做了什么」抹掉。
   */
  it('聚合行点开后仍是**时间序**,失败那条不上浮', async () => {
    const { container } = await draw([
      call('c1'),
      call('c2'),
      call('c3', 'read', { status: 'failed', error: '炸了' }),
    ])
    await open(headOf(container)!)
    await open(container.querySelector('[data-tool-aggregate]')!)
    expect(visibleRows(container).map((row) => row.getAttribute('data-call-id'))).toEqual([
      'c1',
      'c2',
      'c3',
    ])
  })

  it('清单里的行同样能拉开 C1 抽屉(嵌套复用一路到底)', async () => {
    const { container } = await draw([
      call('c1', 'read', { result: { content: [{ type: 'text', text: 'const a = 1' }] } }),
      call('c2', 'bash'),
    ])
    await open(headOf(container)!)
    await open(rowOf(container, 'c1'))
    expect(screen.getByText('结果')).toBeTruthy()
    expect(container.querySelector('[data-block-kind="code"]')).toBeTruthy()
  })
})

/* ═══ §6.5 稳定性纪律 ═══════════════════════════════════════════════════ */

describe('§6.5 第 1 条:行不重挂', () => {
  /**
   * **这一条是本批的硬要求**:一次调用一行,从第一个参数 delta 到收场是同一个
   * DOM 节点。三次换挡(参数收齐 / 开始执行 / 收场)前后拿到的必须是同一个对象。
   *
   * 反证:把 `key` 从 callId 换成下标、或把藏起来的行改成不渲染,这条当场红。
   */
  it('同一 callId 的行在 input-streaming → executing → completed 三挡前后是同一个节点', async () => {
    const streaming = call('c1', 'bash', {
      status: 'input-streaming',
      arguments: {},
      streamingArgs: '{"command": "rg -n',
    })
    const { container, rerender } = render(
      <ToolCard card={presentToolCard([streaming])} ctx={ctx} />,
    )
    await act(async () => undefined)
    const first = rowOf(container, 'c1')

    // 又来一片参数:只改文本,连元素都不换。
    await act(async () => {
      rerender(
        <ToolCard
          card={presentToolCard([{ ...streaming, streamingArgs: '{"command": "rg -n foo"' } as ProjectedToolCall])}
          ctx={ctx}
        />,
      )
    })
    expect(rowOf(container, 'c1')).toBe(first)

    await act(async () => {
      rerender(
        <ToolCard
          card={presentToolCard([
            call('c1', 'bash', { status: 'executing', startTime: T0 }),
          ])}
          ctx={ctx}
        />,
      )
    })
    const executing = rowOf(container, 'c1')

    await act(async () => {
      rerender(
        <ToolCard
          card={presentToolCard([call('c1', 'bash', { durationMs: 900 })])}
          ctx={ctx}
        />,
      )
    })
    expect(rowOf(container, 'c1')).toBe(executing)
  })

  it('第二步到达时,第一步那一行**不重挂**(卡是同一个元素,行也是)', async () => {
    const first = call('c1', 'read')
    const { container, rerender } = render(<ToolCard card={presentToolCard([first])} ctx={ctx} />)
    await act(async () => undefined)
    const card = container.querySelector('[data-tool-card]')
    const row = rowOf(container, 'c1')

    await act(async () => {
      rerender(<ToolCard card={presentToolCard([first, call('c2', 'bash')])} ctx={ctx} />)
    })
    expect(container.querySelector('[data-tool-card]')).toBe(card)
    expect(rowOf(container, 'c1')).toBe(row)
  })
})

describe('§6.5 第 6 / 7 条:活槽位常驻、快步骤不闪', () => {
  it('收起时活槽位画正在跑的那一步', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 5_000)
    const { container } = await draw([
      call('c1', 'read', { durationMs: 30 }),
      call('c2', 'bash', { status: 'executing', startTime: T0 + 4_000 }),
    ])
    expect(visibleRows(container).map((row) => row.getAttribute('data-call-id'))).toEqual(['c2'])
  })

  it('没有正在跑的就画最近收场的那一步 —— 卡不在步与步之间缩回只剩头行', async () => {
    const { container } = await draw([
      call('c1', 'read', { durationMs: 30 }),
      call('c2', 'bash', { durationMs: 40 }),
    ])
    expect(visibleRows(container).map((row) => row.getAttribute('data-call-id'))).toEqual(['c2'])
  })

  /**
   * 第 7 条:开始后 `MIN_BUSY_MS`(250ms)内还没收场的步才露 busy 形。
   * 门里的那一步不露面,活槽位仍然留给上一步的收场形 —— 那 250ms 里卡上
   * 一行都没有,正是二版量出来的 40↔78 抖动。
   */
  it('刚开始(< 250ms)的那一步不抢活槽位,上一步的收场形留在屏上', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 100)
    const { container } = await draw([
      call('c1', 'read', { durationMs: 30 }),
      call('c2', 'bash', { status: 'executing', startTime: T0 }),
    ])
    expect(visibleRows(container).map((row) => row.getAttribute('data-call-id'))).toEqual(['c1'])
  })
})

describe('§6.6 活性读数:分得清「还在收」和「卡住了」', () => {
  /*
   * **静默是从「这台开始等它」算起的**(`silentMsOf`),所以夹具必须走一条真实的
   * 时间线:先上屏(此刻 = 步刚开始),再推时钟。直接把系统钟拨到未来再渲染,
   * 量到的是「刚开始看」,零静默 —— 那正是冷开会话那一形该有的答案。
   */
  const mountThenWait = async (patch: Record<string, unknown>, waitMs: number) => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const view = await draw([call('c1', 'bash', { startTime: T0, ...patch })])
    await act(async () => {
      vi.advanceTimersByTime(waitMs)
    })
    return view
  }

  it('执行中静默 5.1 秒:摘要换成读数、色调转 warn', async () => {
    const { container } = await mountThenWait({ status: 'executing', liveAt: T0 }, 5_100)
    const row = rowOf(container, 'c1')
    expect(row.getAttribute('data-tool-tone')).toBe('warn')
    expect(row.textContent).toContain('已 5 秒没收到数据')
    // 耗时照走 —— 数据停了不代表时间停了(那正是这一格要说的事)。
    expect(row.textContent).toContain('5.1s')
  })

  it('参数流静默说的是另一句(「参数已 N 秒没有新字符」)', async () => {
    const { container } = await mountThenWait(
      {
        status: 'input-streaming',
        arguments: {},
        streamingArgs: '{"command": "rg',
        timestamp: T0,
        liveAt: T0,
      },
      6_000,
    )
    const row = rowOf(container, 'c1')
    expect(row.getAttribute('data-tool-tone')).toBe('warn')
    expect(row.textContent).toContain('参数已 6 秒没有新字符')
  })

  it('静默过 30 秒补一句「可能卡住了」', async () => {
    const { container } = await mountThenWait({ status: 'executing', liveAt: T0 }, 31_000)
    expect(rowOf(container, 'c1').textContent).toContain('可能卡住了')
  })

  it('数据在来就不说静默 —— 判据是静默时长,不是「跑了多久」', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const live = (liveAt: number) =>
      presentToolCard([
        call('c1', 'bash', { status: 'executing', startTime: T0, liveAt }) as ProjectedToolCall,
      ])
    const { container, rerender } = render(<ToolCard card={live(T0)} ctx={ctx} />)
    await act(async () => undefined)
    // 二十秒里每三秒来一片数据 —— 跑了很久,却一刻都没有静默过。
    for (let elapsed = 3_000; elapsed <= 21_000; elapsed += 3_000) {
      await act(async () => {
        vi.advanceTimersByTime(3_000)
        rerender(<ToolCard card={live(T0 + elapsed)} ctx={ctx} />)
      })
    }
    const row = rowOf(container, 'c1')
    expect(row.getAttribute('data-tool-tone')).toBe('busy')
    expect(row.textContent).not.toContain('没收到数据')
  })

  it('读数每秒走一格:时钟推 1 秒,那个数从 5 变 6', async () => {
    const { container } = await mountThenWait({ status: 'executing', liveAt: T0 }, 5_100)
    expect(rowOf(container, 'c1').textContent).toContain('已 5 秒')
    // 假时钟推 1 秒(它同时推 Date.now,所以 10Hz 那只钟走的是同一条时间线)。
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(rowOf(container, 'c1').textContent).toContain('已 6 秒')
  })

  /**
   * **冷开会话那一形**(这条是 `silentMsOf` 那个下限存在的理由):账本里躺着一次
   * 两年前开了头、永远没有结局的调用。直接减对端的钟会读出「已 8 千万秒」——
   * 那句话技术上没说错,可它把一个跨时钟的差当成了「等了多久」。
   */
  it('冷开一条两年前的会话:静默从**打开会话**算起,不是从对端的钟算起', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 86_400_000 * 700)
    const { container } = await draw([
      call('c1', 'bash', { status: 'executing', startTime: T0, timestamp: T0 }),
    ])
    const row = rowOf(container, 'c1')
    expect(row.getAttribute('data-tool-tone')).toBe('busy')
    expect(row.textContent).not.toContain('没收到数据')

    // 看了六秒它还是一个字都没报 —— 那时才说,而且说的是这台自己的六秒。
    await act(async () => {
      vi.advanceTimersByTime(6_000)
    })
    expect(rowOf(container, 'c1').textContent).toContain('已 6 秒没收到数据')
  })
})

/**
 * §6.5 第 2 / 9 条(几何锁定 / 读数定宽)只有在**排版**里才看得见,而 jsdom 不排版。
 * 所以这几条对**样式源**断言 —— 仍然是机器判据(改坏了当场红),比走查清单硬,
 * 与「呼吸的降级写在样式里」那一条同一条路。
 */
describe('§6.5 第 2 / 9 条:几何锁定的样式契约', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/content/tools/ToolCard.module.css'), 'utf-8')
  /** 病历文本里也写着这些词,先剥注释再查(读样式表源的门的既有纪律)。 */
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const block = (selector: string) => {
    const at = code.indexOf(selector)
    expect(at, `样式表里找不到 ${selector}`).toBeGreaterThan(-1)
    return code.slice(at, code.indexOf('}', at))
  }

  it('藏起来的行真的不占位 —— UA 那条 [hidden] 压不过 .row 的 display:flex', () => {
    expect(block('.row[hidden]')).toContain('display: none')
  })

  it('耗时定宽右对齐 + tabular-nums:活耗时走一格不推邻格', () => {
    const rule = block('.toolDuration')
    expect(rule).toContain('font-variant-numeric: tabular-nums')
    expect(rule).toContain('min-width: var(--tool-dur-w)')
    expect(rule).toContain('text-align: end')
  })

  it('摘要单行截断,不换行 —— 一条 delta 不许把行撑高', () => {
    const rule = block('.toolSummary')
    expect(rule).toContain('white-space: nowrap')
    expect(rule).toContain('text-overflow: ellipsis')
  })

  it('行高有地板:换挡时右端从空变成读数,行不许塌', () => {
    expect(block('.row {')).toContain('min-height: var(--tool-row-h)')
  })

  it('零字面值:时长、颜色、间距一律走 token', () => {
    // 组件文件零字面色值 / px / ms(验收第一轴)。`0.45em` / `2px` 是光标那一格的
    // 形,不是量表上的量 —— 它跟着字号走,所以按 em 与 1–2px 的发丝厚度写。
    expect(code).not.toMatch(/:\s*#[0-9a-fA-F]{3,8}\b/)
    expect(code).not.toMatch(/\b\d+ms\b/)
  })
})

describe('§6.2 参数生成中:命令逐字长,右端不写字', () => {
  beforeEach(() => {
    // 参数刚到,离静默阈值还远 —— 不钉时钟的话真实时间与夹具的 T0 差着几十年,
    // 这一行会被活性读数当成「静默了三十年」。
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 120)
  })

  it('半截 JSON 解析成命令首词 + 后面那截,右端空着、尾巴一枚光标', async () => {
    const { container } = await draw([
      call('c1', 'bash', {
        status: 'input-streaming',
        arguments: {},
        streamingArgs: '{"command": "rg -n \\"follow',
        timestamp: T0,
        liveAt: T0,
      }),
    ])
    const row = rowOf(container, 'c1')
    expect(row.textContent).toContain('rg')
    expect(row.textContent).toContain('-n "follow')
    // 「参数生成中」那句话退役 —— 光标已经说了。
    expect(row.textContent).not.toContain('参数生成中')
    expect(row.querySelector('[class*="cursor"]')).toBeTruthy()
  })

  it('认不出的工具退回原始 JSON 尾巴 —— 半截的就是半截的,那是事实', async () => {
    const { container } = await draw([
      call('c1', 'mystery', {
        toolName: 'mystery',
        toolId: 'mystery',
        status: 'input-streaming',
        arguments: {},
        streamingArgs: '{"weird": 1, "half',
        timestamp: T0,
        liveAt: T0,
      }),
    ])
    expect(rowOf(container, 'c1').textContent).toContain('{"weird"')
  })
})


/* ═══ C2-b:执行中的过程读数上屏 ═══════════════════════════════════════ */

describe('C2-b 工具进度活流:执行中那一行在动', () => {
  const executing = (progress: Record<string, unknown> | undefined, patch: Record<string, unknown> = {}) =>
    call('c1', 'bash', {
      status: 'executing',
      arguments: { command: 'seq 1 20' },
      timestamp: T0,
      startTime: T0,
      liveAt: T0 + 50,
      ...(progress ? { progress } : {}),
      ...patch,
    })

  beforeEach(() => {
    // 与上面那一组同一条:不钉时钟,活性读数会把这一行判成「静默了三十年」,
    // 而静默那一级压过进度(有进度就不会静默 —— 这一条本身也值得钉,见末条)。
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 120)
  })

  it('摘要 = outputTail 的**最后一行**', async () => {
    const { container } = await draw([executing({ message: 'seq 1 20', outputTail: '18\n19\n20' })])
    const row = rowOf(container, 'c1')
    expect(row.textContent).toContain('20')
    // 只摆最后一行,前面几行不上这一行(它们在抽屉里)。
    expect(row.textContent).not.toContain('18')
  })

  it('没有输出就退到工具自述那一句', async () => {
    const { container } = await draw([executing({ message: 'seq 1 20' })])
    expect(rowOf(container, 'c1').textContent).toContain('seq 1 20')
  })

  it('一条进度都没有 = 今天的形(presenter 的参数摘要)—— 加性字段,不改旧行为', async () => {
    const { container } = await draw([executing(undefined)])
    expect(rowOf(container, 'c1').textContent).toContain('seq')
  })

  it('报了 ratio → 卡底缘那条进度条,width 跟着走;aria 读得出几成', async () => {
    const { container } = await draw([executing({ outputTail: '10', ratio: 0.5 })])
    const bar = container.querySelector('[data-tool-progress]') as HTMLElement
    expect(bar).toBeTruthy()
    expect(bar.getAttribute('aria-valuenow')).toBe('0.5')
    // jsdom 把 `50.0%` 归一成 `50%` —— 归一前后是同一个值,断言按归一后写。
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('50%')
  })

  it('**没报 ratio 就没有那条条** —— 一条恒为 0 的条是造事实', async () => {
    const { container } = await draw([executing({ outputTail: '10' })])
    expect(container.querySelector('[data-tool-progress]')).toBeNull()
  })

  it('进度更新**不重挂那一行**,也不改卡高(§6.5 第 1 / 2 条)', async () => {
    const view = await draw([executing({ outputTail: '1\n2' })])
    const before = rowOf(view.container, 'c1')
    const beforeHeight = (view.container.firstElementChild as HTMLElement).getAttribute('style')
    view.rerender(
      <ToolCard card={presentToolCard([executing({ outputTail: '19\n20' })])} ctx={ctx} />,
    )
    const after = rowOf(view.container, 'c1')
    expect(after).toBe(before)
    expect(after.textContent).toContain('20')
    expect((view.container.firstElementChild as HTMLElement).getAttribute('style')).toBe(beforeHeight)
  })

  it('抽屉里摆 outputTail 的**全部行**(行上只摆最后一行)', async () => {
    const { container } = await draw([executing({ outputTail: '18\n19\n20' })])
    await open(rowOf(container, 'c1'))
    const live = container.querySelector('[data-tool-live-output]') as HTMLElement
    expect(live).toBeTruthy()
    expect(live.textContent).toBe('18\n19\n20')
  })

  it('收场之后进度整节消失(结果那一节接手)', async () => {
    // 命令里**不含**尾行那几个字,好让「行上不再有进度」这一条量得干净。
    const { container } = await draw([
      call('c1', 'bash', {
        status: 'completed',
        arguments: { command: 'echo hi' },
        progress: { outputTail: 'ZZZ-tail-line' },
        result: { output: 'hi' },
      }),
    ])
    await open(rowOf(container, 'c1'))
    expect(container.querySelector('[data-tool-live-output]')).toBeNull()
    expect(rowOf(container, 'c1').textContent).not.toContain('ZZZ-tail-line')
  })

  it('静默那一级仍然压过进度(数据停了之后进度那句话就是假的)', async () => {
    /*
     * 静默是从「这台开始等它」算起的,所以要走一条真实时间线:先上屏,再推钟
     * (直接把系统钟拨到未来再渲染,量到的是「刚开始看」= 零静默)。
     */
    vi.setSystemTime(T0)
    const view = await draw([executing({ outputTail: 'ZZZ-tail-line' }, { liveAt: T0 })])
    await act(async () => {
      vi.advanceTimersByTime(6_000)
    })
    const row = rowOf(view.container, 'c1')
    expect(row.getAttribute('data-tool-tone')).toBe('warn')
    expect(row.textContent).toContain('没收到数据')
    expect(row.textContent).not.toContain('ZZZ-tail-line')
  })
})
