/**
 * K1 —— `ResourceKernel`。
 *
 * **这份文件的第一条断言就是 K1 的整句话**:界面 / 脚本 / 测试经 `kernel.do(...)`
 * 走的那条路,与 AI 经 `runner.run(tool, invocation)` 走的那条路,对同一个 provider
 * 产生**逐字相同的 Observer 事件序列与 Outcome**。它绿着,就说明「没有第二条管线」
 * 不是一句愿望;它红了,说明有人在某一侧加了一句只有那一侧才跑的判定。
 *
 * (唯一被归一化掉的是 `callId` —— 两次调用本来就该是两个不同的 id。)
 */

import { describe, expect, it } from 'vitest'
import { ToolRunner } from '../../toolkit/runner.js'
import type { ObservedEvent } from '../../toolkit/events.js'
import type { Invocation } from '../../toolkit/run-context.js'
import type { Observer } from '../../toolkit/ports.js'
import { allowAuthorizer, passthroughValidator } from '../../toolkit/__tests__/fakes.js'
import { ResourceKernel } from '../kernel.js'
import { ResourceRegistry } from '../registry.js'
import { DEMO_SCHEME, DemoProvider } from './fakes.js'

const PRINCIPAL = { kind: 'user', userId: 'local' } as const
const CALL_OPTIONS = { principal: PRINCIPAL, sessionId: 'session-1' }

class Trace implements Observer {
  readonly rows: Array<{ toolId: string; input: unknown; event: ObservedEvent }> = []

  on(invocation: Invocation, event: ObservedEvent): void {
    // 刻意不记 callId:两次调用本来就是两个 id,记了就永远比不相等。
    this.rows.push({ toolId: invocation.toolId, input: invocation.input, event })
  }
}

function makeKernel(observer: Observer, provider = new DemoProvider()) {
  const runner = new ToolRunner({ authorizer: allowAuthorizer, observer, validator: passthroughValidator })
  const kernel = new ResourceKernel(new ResourceRegistry(), runner, { callIds: () => 'fixed-call' })
  return { kernel, runner, provider, unmount: kernel.mount(provider) }
}

describe('没有第二条路', () => {
  it('kernel.do 与 AI 路径对同一个 provider 产生逐字相同的事件序列与结局', async () => {
    const viaKernel = new Trace()
    const kernelSide = makeKernel(viaKernel)
    const kernelOutcome = await kernelSide.kernel.do(
      `${DEMO_SCHEME}:42`,
      'rename',
      { title: 'renamed' },
      CALL_OPTIONS,
    )

    // AI 路径:agent-loop 拿到的就是目录里那只工具,自己拼一条 Invocation 调 run。
    const viaModel = new Trace()
    const modelSide = makeKernel(viaModel)
    const tool = modelSide.kernel.toolFor(DEMO_SCHEME)
    expect(tool).toBeTruthy()
    const modelOutcome = await modelSide.runner.run(tool!, {
      callId: 'fixed-call',
      toolId: DEMO_SCHEME,
      input: { op: 'rename', title: 'renamed', ref: `${DEMO_SCHEME}:42` },
      sessionId: 'session-1',
      principal: PRINCIPAL,
    })

    expect(kernelOutcome).toEqual(modelOutcome)
    expect(viaKernel.rows).toEqual(viaModel.rows)
    // 两侧 provider 被调的次序也一样。
    expect(kernelSide.provider.calls).toEqual(modelSide.provider.calls)
    expect(kernelSide.provider.calls).toEqual(['plan:rename', 'apply:rename'])
  })

  it('读也一样:一条不带效果的 Intent,同一条生命周期', async () => {
    const viaKernel = new Trace()
    const kernelSide = makeKernel(viaKernel)
    const kernelOutcome = await kernelSide.kernel.read(`${DEMO_SCHEME}:42`, 'get', {}, CALL_OPTIONS)

    const viaModel = new Trace()
    const modelSide = makeKernel(viaModel)
    const modelOutcome = await modelSide.runner.run(modelSide.kernel.toolFor(DEMO_SCHEME)!, {
      callId: 'fixed-call',
      toolId: DEMO_SCHEME,
      input: { read: 'get', ref: `${DEMO_SCHEME}:42` },
      sessionId: 'session-1',
      principal: PRINCIPAL,
    })

    expect(kernelOutcome).toEqual(modelOutcome)
    expect(viaKernel.rows).toEqual(viaModel.rows)
  })
})

describe('mount / 注销成对', () => {
  it('登记一次,自述、工具、事件总线三样一起到位', () => {
    const { kernel, provider } = makeKernel(new Trace())
    expect(kernel.registry.get(DEMO_SCHEME)?.title).toBe('Demo things')
    expect(kernel.toolFor(DEMO_SCHEME)?.spec.id).toBe(DEMO_SCHEME)
    expect(kernel.tools().map(tool => tool.spec.id)).toEqual([DEMO_SCHEME])
    expect(provider.hub).toBe(kernel.events)
  })

  it('注销一次,三样一起撤;再调一次不抛(幂等)', () => {
    const { kernel, unmount } = makeKernel(new Trace())
    unmount()
    expect(kernel.registry.get(DEMO_SCHEME)).toBeNull()
    expect(kernel.toolFor(DEMO_SCHEME)).toBeUndefined()
    expect(kernel.tools()).toEqual([])
    expect(() => unmount()).not.toThrow()
  })

  it('旧闭包不摘后来者:同一个 scheme 换了提供者之后,旧的注销函数不动新的', () => {
    const { kernel, unmount } = makeKernel(new Trace())
    unmount()
    const second = new DemoProvider()
    kernel.mount(second)
    unmount()
    expect(kernel.toolFor(DEMO_SCHEME)?.provider).toBe(second)
  })

  it('tools() 按 scheme 字典序,与登记先后无关', () => {
    const { kernel } = makeKernel(new Trace())
    const spec = { ...new DemoProvider().spec, scheme: 'aaa' }
    kernel.mount(new DemoProvider({ spec }))
    expect(kernel.tools().map(tool => tool.spec.id)).toEqual(['aaa', DEMO_SCHEME])
  })
})

describe('没人认领的地址', () => {
  it('语法不合 / 没人登记过这个 scheme → failed 的 Outcome,不是异常', async () => {
    const { kernel } = makeKernel(new Trace())
    const syntax = await kernel.do('nonsense', 'rename', {}, CALL_OPTIONS)
    expect(syntax.kind === 'failed' && syntax.error.name).toBe('ResourceSchemeUnknownError')

    const unmounted = await kernel.read('other:1', 'get', {}, CALL_OPTIONS)
    expect(unmounted.kind === 'failed' && unmounted.error.name).toBe('ResourceSchemeUnknownError')
  })
})

describe('事件总线', () => {
  it('provider 发的事件按前缀送到订阅者', () => {
    const { kernel, provider } = makeKernel(new Trace())
    const seen: unknown[] = []
    const stop = kernel.events.watch(`${DEMO_SCHEME}:`, event => seen.push(event))

    provider.hub?.emit(`${DEMO_SCHEME}:42`, 'renamed', { title: 'x' })
    expect(seen).toEqual([{ ref: `${DEMO_SCHEME}:42`, event: 'renamed', payload: { title: 'x' } }])

    stop()
    provider.hub?.emit(`${DEMO_SCHEME}:42`, 'renamed', { title: 'y' })
    expect(seen).toHaveLength(1)
    expect(kernel.events.watcherCount).toBe(0)
  })

  it('前缀卡在段边界上:看住 a/ 的订阅收不到 ab 的事件', () => {
    const { kernel } = makeKernel(new Trace())
    const seen: unknown[] = []
    kernel.events.watch(`${DEMO_SCHEME}:a/`, event => seen.push(event))
    kernel.events.emit(`${DEMO_SCHEME}:ab`, 'renamed', {})
    kernel.events.emit(`${DEMO_SCHEME}:a/1`, 'renamed', {})
    expect(seen).toHaveLength(1)
  })

  it('不合法的前缀当场抛 —— 一个静默失效的订阅是最难查的那种 bug', () => {
    const { kernel } = makeKernel(new Trace())
    expect(() => kernel.events.watch(DEMO_SCHEME, () => {})).toThrow(/Not a resource address prefix/)
  })

  it('一个抛出的订阅者不撤销事实,也不影响别的订阅者', () => {
    const { kernel } = makeKernel(new Trace())
    const seen: unknown[] = []
    kernel.events.watch(`${DEMO_SCHEME}:`, () => {
      throw new Error('a broken panel')
    })
    kernel.events.watch(`${DEMO_SCHEME}:`, event => seen.push(event))
    expect(() => kernel.events.emit(`${DEMO_SCHEME}:1`, 'renamed', {})).not.toThrow()
    expect(seen).toHaveLength(1)
  })
})
