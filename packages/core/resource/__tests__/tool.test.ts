/**
 * K1 —— `ResourceTool`:一个 scheme 投影成的那只工具,跑在**既有的**那条管线上。
 *
 * 每一条断言都是通过 `ToolRunner.run` 观察的,不是直接调 `plan` / `apply`:K1 的
 * 整句话是「不新造第二条管线」,而只有把结局读成 `Outcome`、把过程读成 Observer
 * 事件,才算真的证明了这一点。
 */

import { describe, expect, it } from 'vitest'
import { Intent } from '../../toolkit/intent.js'
import { makeEffect } from '../../toolkit/effects.js'
import { textResult } from '../../toolkit/result.js'
import { ToolRunner } from '../../toolkit/runner.js'
import type { Outcome } from '../../toolkit/outcome.js'
import { combineValidators, type Authorizer, type Validator } from '../../toolkit/ports.js'
import {
  allowAuthorizer,
  makeInvocation,
  passthroughValidator,
  RecordingObserver,
} from '../../toolkit/__tests__/fakes.js'
import { ResourceTool, type ShellDispatch } from '../tool.js'
import { ResourceInputValidator } from '../validator.js'
import { DEMO_SCHEME, DemoProvider, demoSpec } from './fakes.js'

/**
 * K2a —— 这些用例跑的是**装配层真正在用的那位校验者**:先问认得生成 schema 的
 * `ResourceInputValidator`,它不认领的交给兜底(生产里是 `ZodValidator`,这里是
 * 那个 passthrough 假件)。
 *
 * 为什么要换:K1 的时候资源工具的 `spec.input` 是现造的一坨 JSON Schema,`ZodValidator`
 * 那张 WeakMap 反查不到它,于是一律 passthrough —— 参数错只能等到 `plan` 期抛,判成
 * `failed`。K1 把这一条当**取舍**记在 `core/resource/errors.ts` 的头注释里,并指明了
 * 正路:给这份生成 schema 配一个认得它的 Validator。K2a 兑现了那句话,所以下面
 * 「说不出口的那几种」整组从 `failed` 改判 `invalid`。
 */
function resourceValidator(tool: ResourceTool): Validator {
  const resource = new ResourceInputValidator()
  // 生产里这一句在 `ResourceKernel.mount` 里(那是唯一同时知道"哪坨 schema、哪份
  // 自述"的地方);这里直接建工具,所以自己认领一次。
  resource.register(tool.spec.input, tool.provider.spec)
  return combineValidators([resource], passthroughValidator)
}

function makeRunner(authorizer: Authorizer = allowAuthorizer, validator: Validator = passthroughValidator) {
  const observer = new RecordingObserver()
  return { runner: new ToolRunner({ authorizer, observer, validator }), observer }
}

function run(tool: ResourceTool, input: unknown, authorizer?: Authorizer): Promise<Outcome> {
  const { runner } = makeRunner(authorizer, resourceValidator(tool))
  return runner.run(tool, makeInvocation({ toolId: DEMO_SCHEME, input }))
}

/** 没配那位校验者的宿主走的那条路 —— plan 期的具名错仍然是第二道防线。 */
function runWithoutResourceValidator(tool: ResourceTool, input: unknown): Promise<Outcome> {
  const { runner } = makeRunner()
  return runner.run(tool, makeInvocation({ toolId: DEMO_SCHEME, input }))
}

/** 结局是 failed 时那只错误的名字 —— 判定读类名,不 match 措辞。 */
function failureName(outcome: Outcome): string | undefined {
  return outcome.kind === 'failed' ? outcome.error.name : undefined
}

/** 结局是 invalid 时那句话。 */
function invalidMessage(outcome: Outcome): string | undefined {
  return outcome.kind === 'invalid' ? outcome.message : undefined
}

describe('ResourceTool 的 spec', () => {
  it('工具 id 就是 scheme,上界是全部做法的效果并集', () => {
    const tool = new ResourceTool(new DemoProvider())
    expect(tool.spec.id).toBe(DEMO_SCHEME)
    expect(tool.id).toBe(DEMO_SCHEME)
    expect(tool.spec.effects).toEqual(['file_write'])
    expect(tool.spec.concurrency).toBe('sequential')
  })

  it('露不露面问 provider,provider 不答就到处成立', () => {
    expect(new ResourceTool(new DemoProvider({ visible: false })).visibleIn({})).toBe(false)

    const silent = new DemoProvider()
    // 把 visibleIn 摘掉 = 一个没实现这个可选方法的 provider。
    delete (silent as { visibleIn?: unknown }).visibleIn
    expect(new ResourceTool(silent).visibleIn({})).toBe(true)
  })
})

describe('读:结构性无效果', () => {
  it('走 provider.read,授权者看到的 Intent 一条效果都没有', async () => {
    const provider = new DemoProvider()
    const seen: Intent[] = []
    const spy: Authorizer = {
      async decide(intent) {
        seen.push(intent)
        return { kind: 'allow' }
      },
    }
    const outcome = await run(new ResourceTool(provider), { read: 'get', ref: `${DEMO_SCHEME}:42` }, spy)

    expect(outcome.kind).toBe('ok')
    expect(provider.calls).toEqual(['read:get'])
    expect(seen).toHaveLength(1)
    expect(seen[0].effects).toEqual([])
    expect(seen[0].isSideEffectFree).toBe(true)
    expect(seen[0].requiresAuthorization).toBe(false)
  })

  it('读的结果投影成 JSON 文本,ref 与 query 都到得了 provider', async () => {
    const provider = new DemoProvider({
      read: async (name, ref, query) => ({ name, path: ref?.path ?? null, query }),
    })
    const outcome = await run(new ResourceTool(provider), {
      read: 'list',
      ref: `${DEMO_SCHEME}:things`,
      limit: 3,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(JSON.parse(outcome.result.content[0]?.text ?? '')).toEqual({
      name: 'list',
      path: 'things',
      query: { limit: 3 },
    })
  })

  it('没给 ref 的读法说的是整个命名空间,不是错', async () => {
    const provider = new DemoProvider()
    const outcome = await run(new ResourceTool(provider), { read: 'list' })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(JSON.parse(outcome.result.content[0]?.text ?? '').ref).toBeNull()
  })
})

describe('做:两拍都是 provider 的', () => {
  it('plan 与 apply 都走 provider,授权结论贴回 provider 自己那份 Intent', async () => {
    let seenDecision: unknown
    const provider = new DemoProvider({
      apply: async (_op, intent) => {
        seenDecision = intent.decision
        return textResult('renamed')
      },
    })
    const outcome = await run(new ResourceTool(provider), {
      op: 'rename',
      ref: `${DEMO_SCHEME}:42`,
      title: 'x',
    })

    expect(outcome.kind).toBe('ok')
    expect(provider.calls).toEqual(['plan:rename', 'apply:rename'])
    expect(seenDecision).toEqual({ kind: 'allow' })
  })

  it('provider 报的具体效果原样上抬给授权者(而不是从静态上界重造一份)', async () => {
    const provider = new DemoProvider({
      plan: async () =>
        Intent.of({
          effects: [makeEffect('file_write', [`${DEMO_SCHEME}:42`], { barrier: true })],
          preview: { title: 'Wipe demo 42' },
          payload: null,
        }),
    })
    const seen: Intent[] = []
    await run(
      new ResourceTool(provider),
      { op: 'wipe', ref: `${DEMO_SCHEME}:42` },
      { async decide(intent) { seen.push(intent); return { kind: 'allow' } } },
    )
    expect(seen[0].effects).toEqual([
      { kind: 'file_write', resources: [`${DEMO_SCHEME}:42`], barrier: true },
    ])
    expect(seen[0].preview?.title).toBe('Wipe demo 42')
  })

  it('被拒绝的做法不动手', async () => {
    const provider = new DemoProvider()
    const outcome = await run(
      new ResourceTool(provider),
      { op: 'wipe', ref: `${DEMO_SCHEME}:42` },
      { async decide() { return { kind: 'deny', reason: 'no' } } },
    )
    expect(outcome).toEqual({ kind: 'denied', reason: 'no' })
    expect(provider.calls).toEqual(['plan:wipe'])
  })
})

describe('做:说不出口的那几种(K2a 之后是 invalid)', () => {
  it('没有这条做法 → invalid,而且话里带得出有哪些做法;provider 一次都没被叫', async () => {
    const provider = new DemoProvider()
    const outcome = await run(new ResourceTool(provider), { op: 'nope', ref: `${DEMO_SCHEME}:1` })
    expect(outcome.kind).toBe('invalid')
    expect(invalidMessage(outcome)).toContain('has no op "nope"')
    // 「有哪些」是这条判定唯一比 plan 期那只具名错多出来的东西:校验者手上有整份
    // 自述,而 plan 期抛出去的错只说得出"你点的那条不存在"。
    expect(invalidMessage(outcome)).toContain('rename')
    expect(provider.calls).toEqual([])
  })

  it('原型链上的名字不算做法(op 名来自外面)', async () => {
    const outcome = await run(new ResourceTool(new DemoProvider()), { op: 'toString' })
    expect(outcome.kind).toBe('invalid')
  })

  it('既没点读法也没点做法 → invalid(与「点错了」分开说)', async () => {
    const outcome = await run(new ResourceTool(new DemoProvider()), { ref: `${DEMO_SCHEME}:1` })
    expect(outcome.kind).toBe('invalid')
    expect(invalidMessage(outcome)).toContain('names neither a read nor an op')
  })

  it('两支都点名 → invalid(oneOf 的字面意思:恰好一支)', async () => {
    const outcome = await run(new ResourceTool(new DemoProvider()), { read: 'get', op: 'rename' })
    expect(outcome.kind).toBe('invalid')
    expect(invalidMessage(outcome)).toContain('names both')
  })

  it('when 说此刻不该露面 → ResourceOpUnavailableError,plan 不跑', async () => {
    // 这一条**不是**校验者的活:`when` 要场子上下文,而校验者只读自述。所以它照旧
    // 是 plan 期的具名错、照旧判 failed —— K2a 只把"参数错"那一族抬成 invalid。
    const provider = new DemoProvider()
    const outcome = await run(new ResourceTool(provider), { op: 'hidden' })
    expect(failureName(outcome)).toBe('ResourceOpUnavailableError')
    expect(provider.calls).toEqual([])
  })

  it('地址不合语法 / 属于另一种资源 → invalid,两句话分得开', async () => {
    const tool = new ResourceTool(new DemoProvider())
    const syntax = await run(tool, { op: 'rename', ref: 'not-an-address', title: 'x' })
    expect(syntax.kind).toBe('invalid')
    expect(invalidMessage(syntax)).toContain('is not a resource address')

    const foreign = await run(tool, { op: 'rename', ref: 'other:42', title: 'x' })
    expect(foreign.kind).toBe('invalid')
    expect(invalidMessage(foreign)).toContain('belongs to another resource')
  })

  it('第二道防线还在:没配那位校验者的宿主,plan 期照旧抛具名错', async () => {
    // 校验者是**注入**的端口,不是保证。所以 `ResourceTool.plan` 里那几只具名错
    // 一条都没删 —— 一台没串上资源校验者的 runner(或者手搓 Intent 直接调 apply 的
    // 调用方)仍然拦得住,只是结局读成 failed。
    const tool = new ResourceTool(new DemoProvider())
    expect(failureName(await runWithoutResourceValidator(tool, { op: 'nope' })))
      .toBe('ResourceOpUnknownError')
    expect(failureName(await runWithoutResourceValidator(tool, { ref: `${DEMO_SCHEME}:1` })))
      .toBe('ResourceCallShapeError')
    const foreign = await runWithoutResourceValidator(tool, { op: 'rename', ref: 'other:42', title: 'x' })
    expect(failureName(foreign)).toBe('ResourceRefError')
    if (foreign.kind === 'failed') {
      expect((foreign.error as { reason?: string }).reason).toBe('scheme')
    }
  })
})

describe('两道效果检查', () => {
  it('op 级:报出这条做法没声明过的效果 → ResourceEffectViolationError,apply 不跑', async () => {
    // `rename` 声明的是 `[]`,而同一个 scheme 里 `wipe` 声明过 `file_write` ——
    // 所以 scheme 级那道(Runner 的 assertWithinDeclaredEffects)放它过去。
    const provider = new DemoProvider({
      plan: async () => Intent.of({ effects: [makeEffect('file_write', ['x'])], payload: null }),
    })
    const outcome = await run(new ResourceTool(provider), { op: 'rename', ref: `${DEMO_SCHEME}:1`, title: 'x' })
    expect(failureName(outcome)).toBe('ResourceEffectViolationError')
    expect(provider.calls).toEqual(['plan:rename'])
  })

  it('scheme 级:报出整个 scheme 都没声明过的效果 → Runner 的 EffectViolationError', async () => {
    const provider = new DemoProvider({
      plan: async () => Intent.of({ effects: [makeEffect('bash', ['rm -rf /'])], payload: null }),
    })
    const outcome = await run(new ResourceTool(provider), { op: 'wipe', ref: `${DEMO_SCHEME}:1` })
    // 两道都会红,先撞上的是 op 级那一道 —— 它更严。判据取「apply 没跑」。
    expect(outcome.kind).toBe('failed')
    expect(provider.calls).toEqual(['plan:wipe'])
  })
})

describe('家在壳里的做法', () => {
  it('没有派发端口 → ResourceHomeUnavailableError(结构化降级,不是静默),plan 不跑', async () => {
    const provider = new DemoProvider()
    const outcome = await run(new ResourceTool(provider), { op: 'focus', ref: `${DEMO_SCHEME}:1` })
    expect(failureName(outcome)).toBe('ResourceHomeUnavailableError')
    expect(provider.calls).toEqual([])
  })

  it('有派发端口 → apply 那一步走端口,provider.apply 不跑(但 plan 仍在 core 里跑)', async () => {
    const dispatched: unknown[] = []
    const shell: ShellDispatch = {
      async run(op, ref, params) {
        dispatched.push({ op, path: ref?.path ?? null, params })
        return textResult('focused')
      },
    }
    const provider = new DemoProvider()
    const outcome = await run(new ResourceTool(provider, { shell }), {
      op: 'focus',
      ref: `${DEMO_SCHEME}:1`,
      line: 120,
    })

    expect(outcome.kind).toBe('ok')
    // 授权在 core 里做完,apply 才出去 —— plan 跑过,apply 没跑过。
    expect(provider.calls).toEqual(['plan:focus'])
    expect(dispatched).toEqual([{ op: 'focus', path: '1', params: { line: 120 } }])
  })
})

describe('它就是一只普通工具', () => {
  it('过的是同一条生命周期:planned → decided → finished', async () => {
    const { runner, observer } = makeRunner()
    await runner.run(
      new ResourceTool(new DemoProvider()),
      makeInvocation({ toolId: DEMO_SCHEME, input: { op: 'rename', ref: `${DEMO_SCHEME}:1`, title: 'x' } }),
    )
    expect(observer.lifecyclePhases()).toEqual(['planned', 'decided', 'finished'])
  })

  it('取消恒是 aborted,不是 failed', async () => {
    const controller = new AbortController()
    const provider = new DemoProvider({
      apply: async () => {
        controller.abort()
        return new Promise<never>(() => {})
      },
    })
    const { runner } = makeRunner()
    const outcome = await runner.run(
      new ResourceTool(provider),
      makeInvocation({ toolId: DEMO_SCHEME, input: { op: 'rename', ref: `${DEMO_SCHEME}:1`, title: 'x' } }),
      controller.signal,
    )
    expect(outcome.kind).toBe('aborted')
  })

  it('自述空到只有读法时,工具照样建得出来(上界为空,做法一条都调不到)', async () => {
    const tool = new ResourceTool(new DemoProvider({ spec: demoSpec({ ops: {} }) }))
    expect(tool.spec.effects).toEqual([])
    expect((await run(tool, { op: 'rename', title: 'x' })).kind).toBe('invalid')
    expect((await run(tool, { read: 'get' })).kind).toBe('ok')
  })
})
