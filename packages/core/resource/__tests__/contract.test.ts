/**
 * K0 —— 契约校验(`docs/design/atom-2026-09.md` §7 盲点 7:「加功能不许改骨架」
 * 那道门的判定函数)。
 *
 * 每一种 problem 各一例,外加「一次只报第一条且顺序稳定」与「空表合法」两条。
 * 断言一律读 `problem.kind` 与定位字段,不去 match 人话字符串 —— 那句话会被改,
 * kind 不会(contract.ts 文件头)。
 */

import { describe, expect, it } from 'vitest'
import {
  assertResourceSpec,
  describeResourceSpecProblem,
  formatResourceSpecProblem,
  ResourceSpecError,
} from '../contract.js'
import type { ResourceSpec } from '../spec.js'

const anySchema = { type: 'object' }

/** 一份合法的最小自述:三张表都在,都是空的。 */
function baseSpec(overrides: Record<string, unknown> = {}): unknown {
  return { scheme: 'demo', title: 'Demo', reads: {}, ops: {}, events: {}, ...overrides }
}

function goodOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: 'Do it', params: anySchema, effects: ['read'], home: 'core', ...overrides }
}

describe('resource spec contract', () => {
  it('accepts empty member tables — a resource may have reads and no ops', () => {
    expect(describeResourceSpecProblem(baseSpec())).toBeNull()
    expect(
      describeResourceSpecProblem(
        baseSpec({ reads: { list: { title: 'List', query: anySchema, result: anySchema } } }),
      ),
    ).toBeNull()
  })

  it('accepts a fully populated spec, hooks and state included', () => {
    const spec: ResourceSpec = {
      scheme: 'demo',
      title: 'Demo',
      reads: { get: { title: 'Get one', query: anySchema, result: anySchema } },
      ops: {
        act: {
          title: 'Act',
          params: anySchema,
          effects: ['read', 'session_message'],
          home: 'shell',
          when: () => true,
          describe: () => 'acting',
          keymap: true,
          entity: 'item',
        },
      },
      events: { changed: { title: 'Changed', payload: anySchema } },
      // K4-a:`read` / `scope` 两格也算「fully populated」。`read` 指着上面那条
      // `get` —— 状态名与读法名不同名正是这一格存在的理由。
      state: {
        count: { title: 'Count', schema: anySchema, volatility: 'turn', read: 'get', scope: 'turn-origin' },
      },
    }
    expect(describeResourceSpecProblem(spec)).toBeNull()
  })

  it('reports not-object for the spec itself and for each missing member table', () => {
    expect(describeResourceSpecProblem(null)).toEqual({ kind: 'not-object', where: 'spec' })
    expect(describeResourceSpecProblem('demo')).toEqual({ kind: 'not-object', where: 'spec' })
    expect(describeResourceSpecProblem([])).toEqual({ kind: 'not-object', where: 'spec' })
    expect(describeResourceSpecProblem(baseSpec({ reads: undefined }))).toEqual({ kind: 'not-object', where: 'reads' })
    expect(describeResourceSpecProblem(baseSpec({ ops: 3 }))).toEqual({ kind: 'not-object', where: 'ops' })
    expect(describeResourceSpecProblem(baseSpec({ events: null }))).toEqual({ kind: 'not-object', where: 'events' })
    expect(describeResourceSpecProblem(baseSpec({ state: 'no' }))).toEqual({ kind: 'not-object', where: 'state' })
    // 表里的一条不是对象,定位到那一条。
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: 7 } }))).toEqual({ kind: 'not-object', where: 'op:act' })
  })

  it('reports scheme-grammar, carrying the offending value', () => {
    expect(describeResourceSpecProblem(baseSpec({ scheme: 'Demo' }))).toEqual({ kind: 'scheme-grammar', scheme: 'Demo' })
    expect(describeResourceSpecProblem(baseSpec({ scheme: '' }))).toEqual({ kind: 'scheme-grammar', scheme: '' })
    expect(describeResourceSpecProblem(baseSpec({ scheme: undefined }))).toEqual({
      kind: 'scheme-grammar',
      scheme: undefined,
    })
    expect(describeResourceSpecProblem(baseSpec({ scheme: 7 }))).toEqual({ kind: 'scheme-grammar', scheme: 7 })
  })

  it('reports bad-title for the spec and for a member entry', () => {
    expect(describeResourceSpecProblem(baseSpec({ title: '' }))).toEqual({
      kind: 'bad-title',
      scheme: 'demo',
      where: 'spec',
    })
    expect(
      describeResourceSpecProblem(baseSpec({ events: { changed: { payload: anySchema } } })),
    ).toEqual({ kind: 'bad-title', scheme: 'demo', where: 'event:changed' })
  })

  it('reports name-grammar for every member kind', () => {
    expect(describeResourceSpecProblem(baseSpec({ reads: { 'get-one': {} } }))).toEqual({
      kind: 'name-grammar',
      scheme: 'demo',
      member: 'read',
      name: 'get-one',
    })
    expect(describeResourceSpecProblem(baseSpec({ ops: { Act: goodOp() } }))).toEqual({
      kind: 'name-grammar',
      scheme: 'demo',
      member: 'op',
      name: 'Act',
    })
    expect(describeResourceSpecProblem(baseSpec({ events: { '2changed': {} } }))).toEqual({
      kind: 'name-grammar',
      scheme: 'demo',
      member: 'event',
      name: '2changed',
    })
    expect(
      describeResourceSpecProblem(baseSpec({ state: { unread_count: { title: 'x', schema: anySchema, volatility: 'turn' } } })),
    ).toEqual({ kind: 'name-grammar', scheme: 'demo', member: 'state', name: 'unread_count' })
  })

  it('reports bad-schema, naming the field that is not a JSON object', () => {
    expect(
      describeResourceSpecProblem(baseSpec({ reads: { get: { title: 'Get', query: 'nope', result: anySchema } } })),
    ).toEqual({ kind: 'bad-schema', scheme: 'demo', member: 'read', name: 'get', field: 'query' })
    expect(
      describeResourceSpecProblem(baseSpec({ reads: { get: { title: 'Get', query: anySchema } } })),
    ).toEqual({ kind: 'bad-schema', scheme: 'demo', member: 'read', name: 'get', field: 'result' })
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ params: [] }) } }))).toEqual({
      kind: 'bad-schema',
      scheme: 'demo',
      member: 'op',
      name: 'act',
      field: 'params',
    })
    expect(
      describeResourceSpecProblem(baseSpec({ state: { count: { title: 'C', volatility: 'turn' } } })),
    ).toEqual({ kind: 'bad-schema', scheme: 'demo', member: 'state', name: 'count', field: 'schema' })
  })

  it('reports bad-effects when effects is not an array', () => {
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ effects: 'read' }) } }))).toEqual({
      kind: 'bad-effects',
      scheme: 'demo',
      name: 'act',
    })
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ effects: undefined }) } }))).toEqual({
      kind: 'bad-effects',
      scheme: 'demo',
      name: 'act',
    })
  })

  it('reports unknown-effect — a misspelled effect class is a hard error at registration', () => {
    // 运行时 `effectPolicyFor` 给不认识的 kind 兜底成 ask;登记时不兜底,理由在
    // contract.ts:兜底是给一次调用留活路,放行则是让一份说谎的自述长期存在。
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ effects: ['reed'] }) } }))).toEqual({
      kind: 'unknown-effect',
      scheme: 'demo',
      name: 'act',
      effect: 'reed',
    })
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ effects: ['read', 7] }) } }))).toEqual({
      kind: 'unknown-effect',
      scheme: 'demo',
      name: 'act',
      effect: '7',
    })
    // 空 effects 合法:「这条做法不打扰任何人」。
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ effects: [] }) } }))).toBeNull()
  })

  it('reports bad-home', () => {
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ home: 'server' }) } }))).toEqual({
      kind: 'bad-home',
      scheme: 'demo',
      name: 'act',
      home: 'server',
    })
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ home: undefined }) } }))).toEqual({
      kind: 'bad-home',
      scheme: 'demo',
      name: 'act',
      home: undefined,
    })
  })

  it('reports bad-hook when when/describe are present but not functions', () => {
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ when: true }) } }))).toEqual({
      kind: 'bad-hook',
      scheme: 'demo',
      name: 'act',
      field: 'when',
    })
    expect(describeResourceSpecProblem(baseSpec({ ops: { act: goodOp({ describe: 'text' }) } }))).toEqual({
      kind: 'bad-hook',
      scheme: 'demo',
      name: 'act',
      field: 'describe',
    })
  })

  it('reports bad-volatility', () => {
    expect(
      describeResourceSpecProblem(baseSpec({ state: { count: { title: 'C', schema: anySchema, volatility: 'hot' } } })),
    ).toEqual({ kind: 'bad-volatility', scheme: 'demo', name: 'count', volatility: 'hot' })
  })

  /**
   * K4-a —— 一格状态必须**指得到一条真读法**,缺席时那条读法与状态同名。
   *
   * 为什么是硬错而不是「投影期悄悄跳过」:`StateSpec` 说的就是「哪些**读法**值得
   * 主动喂给提示词」,一格指不到读法的状态是一句自相矛盾的自述。登记时它是一次
   * 可查的拼写错误;放到投影期,它只剩一格安静消失的变量。
   */
  it('reports bad-state-read: an explicit read that names nothing, a non-string, and the missing same-name default', () => {
    const reads = { get: { title: 'Get one', query: anySchema, result: anySchema } }
    const state = (extra: Record<string, unknown>) => ({
      count: { title: 'C', schema: anySchema, volatility: 'turn', ...extra },
    })
    expect(describeResourceSpecProblem(baseSpec({ reads, state: state({ read: 'nope' }) }))).toEqual({
      kind: 'bad-state-read', scheme: 'demo', name: 'count', read: 'nope',
    })
    expect(describeResourceSpecProblem(baseSpec({ reads, state: state({ read: 7 }) }))).toEqual({
      kind: 'bad-state-read', scheme: 'demo', name: 'count', read: 7,
    })
    // 缺席的 `read` = 「与状态同名的那条读法」,而这份自述里没有 `count`。
    expect(describeResourceSpecProblem(baseSpec({ reads, state: state({}) }))).toEqual({
      kind: 'bad-state-read', scheme: 'demo', name: 'count', read: undefined,
    })
    // 同名的读法在,就不必写 `read`。
    expect(
      describeResourceSpecProblem(
        baseSpec({
          reads: { count: { title: 'Count', query: anySchema, result: anySchema } },
          state: state({}),
        }),
      ),
    ).toBeNull()
    // 原型链上的名字不算读法(`opOf` / `readOf` 那条 own-property 判据的同一句话)。
    expect(describeResourceSpecProblem(baseSpec({ reads, state: state({ read: 'toString' }) }))).toEqual({
      kind: 'bad-state-read', scheme: 'demo', name: 'count', read: 'toString',
    })
  })

  it('reports bad-state-scope, and accepts both members plus absence', () => {
    const reads = { count: { title: 'Count', query: anySchema, result: anySchema } }
    const withScope = (scope?: unknown) => baseSpec({
      reads,
      state: { count: { title: 'C', schema: anySchema, volatility: 'turn', ...(scope === undefined ? {} : { scope }) } },
    })
    expect(describeResourceSpecProblem(withScope('per-window'))).toEqual({
      kind: 'bad-state-scope', scheme: 'demo', name: 'count', scope: 'per-window',
    })
    expect(describeResourceSpecProblem(withScope('singleton'))).toBeNull()
    expect(describeResourceSpecProblem(withScope('turn-origin'))).toBeNull()
    expect(describeResourceSpecProblem(withScope())).toBeNull()
  })

  it('reports only the first problem, in an order that does not depend on how the spec was written', () => {
    // spec 本体的问题排在成员之前。
    expect(
      describeResourceSpecProblem({ scheme: 'Demo', title: '', reads: 1, ops: 1, events: 1 }),
    ).toEqual({ kind: 'scheme-grammar', scheme: 'Demo' })
    // reads 排在 ops 之前。
    expect(
      describeResourceSpecProblem(baseSpec({ reads: { Get: {} }, ops: { Act: goodOp() } })),
    ).toEqual({ kind: 'name-grammar', scheme: 'demo', member: 'read', name: 'Get' })

    // 同一张表里按键的**字典序**,与书写顺序无关:两份内容相同、书写顺序相反的
    // 自述必须报同一条。
    const first = { Bad: goodOp(), Also: goodOp() }
    const second = { Also: goodOp(), Bad: goodOp() }
    const expected = { kind: 'name-grammar', scheme: 'demo', member: 'op', name: 'Also' }
    expect(describeResourceSpecProblem(baseSpec({ ops: first }))).toEqual(expected)
    expect(describeResourceSpecProblem(baseSpec({ ops: second }))).toEqual(expected)
  })

  it('assertResourceSpec throws a ResourceSpecError carrying the problem', () => {
    expect(() => assertResourceSpec(baseSpec())).not.toThrow()
    let caught: unknown
    try {
      assertResourceSpec(baseSpec({ ops: { act: goodOp({ home: 'server' }) } }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ResourceSpecError)
    expect((caught as ResourceSpecError).name).toBe('ResourceSpecError')
    expect((caught as ResourceSpecError).problem).toEqual({
      kind: 'bad-home',
      scheme: 'demo',
      name: 'act',
      home: 'server',
    })
    expect((caught as ResourceSpecError).message).toContain('act')
  })

  it('formats every problem kind into a non-empty sentence', () => {
    const problems = [
      { kind: 'not-object', where: 'spec' },
      { kind: 'scheme-grammar', scheme: 'Demo' },
      { kind: 'bad-title', scheme: 'demo', where: 'spec' },
      { kind: 'name-grammar', scheme: 'demo', member: 'op', name: 'Act' },
      { kind: 'bad-schema', scheme: 'demo', member: 'op', name: 'act', field: 'params' },
      { kind: 'bad-effects', scheme: 'demo', name: 'act' },
      { kind: 'unknown-effect', scheme: 'demo', name: 'act', effect: 'reed' },
      { kind: 'bad-home', scheme: 'demo', name: 'act', home: 'server' },
      { kind: 'bad-volatility', scheme: 'demo', name: 'count', volatility: 'hot' },
      { kind: 'bad-hook', scheme: 'demo', name: 'act', field: 'when' },
      { kind: 'bad-state-read', scheme: 'demo', name: 'count', read: 'nope' },
      { kind: 'bad-state-scope', scheme: 'demo', name: 'count', scope: 'per-window' },
      { kind: 'bad-exposure', scheme: 'demo', field: 'aiTool', value: 'no' },
    ] as const
    for (const problem of problems) {
      expect(formatResourceSpecProblem(problem), problem.kind).toBeTruthy()
    }
    // 十三支 = 联合的全部分支。少一支这条就该改。
    expect(new Set(problems.map(item => item.kind)).size).toBe(13)
  })

  /**
   * K5-a —— 出口声明。契约只查**形状**:一格拼错的 `aiTool: 'no'` 按真值算的话,
   * 一次拼错会静默地变成「照常投影」。
   */
  describe('exposure', () => {
    it('accepts absence, an empty table, and either boolean', () => {
      expect(describeResourceSpecProblem(baseSpec())).toBeNull()
      expect(describeResourceSpecProblem(baseSpec({ exposure: {} }))).toBeNull()
      expect(describeResourceSpecProblem(baseSpec({ exposure: { aiTool: false } }))).toBeNull()
      expect(describeResourceSpecProblem(baseSpec({ exposure: { aiTool: true } }))).toBeNull()
    })

    it('refuses a non-object exposure', () => {
      expect(describeResourceSpecProblem(baseSpec({ exposure: 'none' }))).toEqual({
        kind: 'not-object',
        where: 'exposure',
      })
    })

    it('refuses a truthy-looking string instead of reading it as true', () => {
      expect(describeResourceSpecProblem(baseSpec({ exposure: { aiTool: 'no' } }))).toEqual({
        kind: 'bad-exposure',
        scheme: 'demo',
        field: 'aiTool',
        value: 'no',
      })
      expect(describeResourceSpecProblem(baseSpec({ exposure: { aiTool: 0 } }))).toEqual({
        kind: 'bad-exposure',
        scheme: 'demo',
        field: 'aiTool',
        value: 0,
      })
    })

    it('is judged as part of the spec body — before the member tables', () => {
      // 顺序稳定的那条纪律:`exposure` 与 scheme / title 同属 spec 本体,所以它比
      // 一条写坏的做法先报。
      const problem = describeResourceSpecProblem(
        baseSpec({ exposure: { aiTool: 'no' }, ops: { Act: goodOp() } }),
      )
      expect(problem?.kind).toBe('bad-exposure')
    })
  })
})
