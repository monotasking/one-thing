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

import { describe, expect, it, vi } from 'vitest'
import { ToolRunner } from '../../toolkit/runner.js'
import type { ObservedEvent } from '../../toolkit/events.js'
import type { Invocation } from '../../toolkit/run-context.js'
import type { Observer } from '../../toolkit/ports.js'
import { combineValidators } from '../../toolkit/ports.js'
import { allowAuthorizer, passthroughValidator } from '../../toolkit/__tests__/fakes.js'
import { NO_ORIGIN_SESSION, ResourceKernel } from '../kernel.js'
import { ResourceRegistry } from '../registry.js'
import { ResourceInputValidator } from '../validator.js'
import { textResult } from '../../toolkit/result.js'
import { DEMO_SCHEME, DemoProvider, demoSpec } from './fakes.js'

const PRINCIPAL = { kind: 'user', userId: 'local' } as const
const CALL_OPTIONS = { principal: PRINCIPAL, sessionId: 'session-1' }

class Trace implements Observer {
  readonly rows: Array<{ toolId: string; input: unknown; event: ObservedEvent }> = []

  on(invocation: Invocation, event: ObservedEvent): void {
    // 刻意不记 callId:两次调用本来就是两个 id,记了就永远比不相等。
    this.rows.push({ toolId: invocation.toolId, input: invocation.input, event })
  }
}

/**
 * K2a —— 与装配层同形:同一个 `ResourceInputValidator` 实例既串进 runner 的
 * `Validator`,又交给内核去认领每个 mount 的入参契约。生产里这两半由
 * `backend/wiring/resource/index.ts` 的 `createResourceKernel` 一处扣上。
 */
function makeKernel(observer: Observer, provider = new DemoProvider()) {
  const resourceValidator = new ResourceInputValidator()
  const runner = new ToolRunner({
    authorizer: allowAuthorizer,
    observer,
    validator: combineValidators([resourceValidator], passthroughValidator),
  })
  const kernel = new ResourceKernel(new ResourceRegistry(), runner, {
    callIds: () => 'fixed-call',
    validator: resourceValidator,
  })
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

  it('注销一次,三样一起撤;再调一次不抛(幂等)', async () => {
    const { kernel, unmount } = makeKernel(new Trace())
    await unmount()
    expect(kernel.registry.get(DEMO_SCHEME)).toBeNull()
    expect(kernel.toolFor(DEMO_SCHEME)).toBeUndefined()
    expect(kernel.tools()).toEqual([])
    await expect(unmount()).resolves.toBeUndefined()
  })

  it('旧闭包不摘后来者:同一个 scheme 换了提供者之后,旧的注销函数不动新的', async () => {
    const { kernel, unmount } = makeKernel(new Trace())
    await unmount()
    const second = new DemoProvider()
    kernel.mount(second)
    await unmount()
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

  it('认得出 scheme、点不出做法 → invalid,不是 failed(K2a)', async () => {
    // 「没人登记过这个 scheme」在**进管线之前**判(那决定的是调哪只工具),所以它
    // 仍然是 failed;「这只工具没有这条做法」是参数错,K2a 之后由校验者判 invalid。
    // 两者是两句不同的话,分开是有意的。
    const { kernel } = makeKernel(new Trace())
    const outcome = await kernel.do(`${DEMO_SCHEME}:1`, 'nope', {}, CALL_OPTIONS)
    expect(outcome.kind).toBe('invalid')
  })
})

describe('无会话的调用方(K2a)', () => {
  it('不给 sessionId,管线照跑,而 Invocation 上的坐标是那个保留值', async () => {
    const seen: string[] = []
    const { kernel } = makeKernel({
      on(invocation) {
        seen.push(invocation.sessionId)
      },
    })
    const outcome = await kernel.do(`${DEMO_SCHEME}:42`, 'rename', { title: 'x' }, { principal: PRINCIPAL })
    expect(outcome.kind).toBe('ok')
    // 审计与取消都读这一格,所以它必须是**一个具名的值**而不是某条会话的 id ——
    // 借一条会话的坐标,审计就会读成「那条会话自己改了自己」(K1 留账)。
    expect([...new Set(seen)]).toEqual([NO_ORIGIN_SESSION])
  })

  it('保留坐标不是某条会话的 id,也不是空串', () => {
    // 空串会被下游当"没填"处理(而不是"没有发起会话"),那是两件事。
    expect(NO_ORIGIN_SESSION.length).toBeGreaterThan(0)
    // 会话 id 是 uuid,字母表里没有 `@` —— 撞不上,而且一眼看得出不是 id。
    expect(NO_ORIGIN_SESSION.startsWith('@')).toBe(true)
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

/**
 * K2a' —— 生命周期(`docs/design/atom-2026-09.md` §10.1 / §10.2)。
 *
 * 两张表上被这一组用例钉住的两格:
 *   · §10.1「**在飞的做在 dispose 时必须以 `Outcome.aborted` 收场,不许悬着**」;
 *   · §10.2 在飞那一行「**unmount 撞上在飞:先让在飞的走完或被中止,再摘;不许摘了
 *     之后 apply 还在写**」。
 *
 * 假件的形状是这一组用例的全部机关:一个 `apply` 里**只在收到取消信号之后才**
 * resolve 的 provider。不这么写就测不出区别 —— 一个正常返回的 apply 无论内核有没有
 * 拉那只 `AbortController` 都会按时收场。
 */
describe('生命周期', () => {
  /** apply 挂在信号上:不掐它就永远不回来。返回它有没有真收到过取消。 */
  function hangingProvider() {
    const state = { aborted: false, applied: false, finished: false }
    const provider = new DemoProvider({
      apply: (op, _intent, ctx) => new Promise(resolve => {
        state.applied = true
        ctx.abort.onAbort(() => {
          state.aborted = true
          state.finished = true
          resolve(textResult(`aborted ${op}`))
        })
      }),
    })
    return { provider, state }
  }

  it('dispose:在飞的「做」以 aborted 收场,dispose 不悬着', async () => {
    const { provider, state } = hangingProvider()
    const { kernel } = makeKernel(new Trace(), provider)
    const inflight = kernel.do(`${DEMO_SCHEME}:1`, 'rename', { title: 'x' }, CALL_OPTIONS)
    // 让它真的走进 apply,不然「掐在飞」掐的是一件还没开始的事。
    await vi.waitFor(() => expect(state.applied).toBe(true))

    await kernel.dispose()
    expect(state.aborted).toBe(true)
    expect((await inflight).kind).toBe('aborted')
    // 注销了全部 provider:再来的调用回到「未登记」那一行。
    expect(kernel.registry.list()).toEqual([])
    expect(kernel.tools()).toEqual([])
    const after = await kernel.do(`${DEMO_SCHEME}:1`, 'rename', { title: 'y' }, CALL_OPTIONS)
    expect(after.kind === 'failed' && after.error.name).toBe('ResourceSchemeUnknownError')
  })

  it('dispose 幂等:第二次等的是第一次那条链,不是重跑一遍', async () => {
    const { kernel } = makeKernel(new Trace())
    await Promise.all([kernel.dispose(), kernel.dispose()])
    await expect(kernel.dispose()).resolves.toBeUndefined()
  })

  it('unmount 撞上在飞:注销回来的那一刻,provider 已经收到过取消,表也空了', async () => {
    const { provider, state } = hangingProvider()
    const { kernel, unmount } = makeKernel(new Trace(), provider)
    const inflight = kernel.do(`${DEMO_SCHEME}:1`, 'rename', { title: 'x' }, CALL_OPTIONS)
    await vi.waitFor(() => expect(state.applied).toBe(true))

    await unmount()
    // 这两句就是 §10.2「不许摘了之后 apply 还在写」:注销 resolve 的时候,那次
    // apply 已经收场(`finished`),而不是还挂在 promise 上。
    expect(state.aborted).toBe(true)
    expect(state.finished).toBe(true)
    expect(kernel.registry.get(DEMO_SCHEME)).toBeNull()
    expect(kernel.toolFor(DEMO_SCHEME)).toBeUndefined()
    expect((await inflight).kind).toBe('aborted')
  })

  it('注销只掐自己那一份:另一个命名空间的在飞不受影响', async () => {
    const { provider, state } = hangingProvider()
    const other = new DemoProvider({ spec: { ...demoSpec(), scheme: 'aaa' } })
    const { kernel, unmount } = makeKernel(new Trace(), provider)
    kernel.mount(other)

    const survivor = kernel.do('aaa:1', 'rename', { title: 'x' }, CALL_OPTIONS)
    const doomed = kernel.do(`${DEMO_SCHEME}:1`, 'rename', { title: 'x' }, CALL_OPTIONS)
    await vi.waitFor(() => expect(state.applied).toBe(true))

    await unmount()
    expect((await doomed).kind).toBe('aborted')
    // `other` 的 apply 是假件的缺省实现(直接返回),所以它照常 ok —— 它压根不该
    // 被那次注销碰到。
    expect((await survivor).kind).toBe('ok')
  })

  it('调用方自己的 signal 照旧有效 —— 合成没有吃掉它', async () => {
    const { provider, state } = hangingProvider()
    const { kernel } = makeKernel(new Trace(), provider)
    const controller = new AbortController()
    const inflight = kernel.do(
      `${DEMO_SCHEME}:1`,
      'rename',
      { title: 'x' },
      { ...CALL_OPTIONS, signal: controller.signal },
    )
    await vi.waitFor(() => expect(state.applied).toBe(true))
    controller.abort()
    expect((await inflight).kind).toBe('aborted')
    await kernel.dispose()
  })
})
