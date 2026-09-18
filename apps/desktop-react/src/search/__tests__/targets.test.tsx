import { describe, expect, it } from 'vitest'
import {
  registerTargetRenderer,
  resolveTargetRenderer,
  targetRendererKinds,
} from '../targets'
import type { SearchTargetContext } from '../targets'
import type { SearchRow } from '../types'

/**
 * 目标渲染注册表(检索重建 S4a,设计 §4.3 末段 / §9 第二条)。
 *
 * 三条判据,与查看器 / 块那两张表逐条同款:重复注册抛、注册只在 barrel、
 * **查不到不是错误**(画标题行 + dev warn,绝不吞结果)。
 */

function row(kind: string, payload: unknown): SearchRow {
  return {
    id: 'r1',
    capability: 'x',
    text: '一行',
    origin: { kind: 'time', time: '刚刚' },
    target: { kind, payload },
  }
}

function spyContext(): SearchTargetContext & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    enterSession: (sessionId, messageId) => calls.push(`enter:${sessionId}:${messageId ?? ''}`),
    openFile: (path, line) => calls.push(`open:${path}:${line ?? ''}`),
    runAction: actionId => calls.push(`run:${actionId}`),
  }
}

describe('注册表', () => {
  it('barrel 一 import 就有六种 —— 「这台上有哪些目标形」一眼看全', () => {
    expect(targetRendererKinds().sort()).toEqual(
      ['action', 'chat', 'file', 'message', 'note', 'prompt'],
    )
  })

  it('重复注册 = 抛错,不静默覆盖(判例 1)', () => {
    expect(() => registerTargetRenderer({
      kind: 'chat',
      badge: () => ({ text: '' }),
      activate: () => {},
    })).toThrow('search target renderer already registered: chat')
  })

  it('注销只删自己那一条 —— 晚到的注销不许把后来那个同名的顺手删掉', () => {
    const first = { kind: 'tmp', badge: () => ({ text: 'A' }), activate: () => {} }
    const dispose = registerTargetRenderer(first)
    dispose()
    const second = { kind: 'tmp', badge: () => ({ text: 'B' }), activate: () => {} }
    const disposeSecond = registerTargetRenderer(second)
    dispose() // 迟到的第一份注销
    expect(resolveTargetRenderer('tmp')).toBe(second)
    disposeSecond()
  })

  /** §11 S4 的反证:「摘一个目标渲染器注册 → 该类画成标题行且 warn」。 */
  it('查不到不是错误:答 undefined 并 warn 一次(同一种 kind 不刷屏)', async () => {
    // `getLogger` 每次现造一只(见 services/log),所以 spy 那只对象没用 ——
    // 读的是环缓冲那份**记录**,它才是「到底 warn 了没有」的唯一事实。
    const { dumpLog } = await import('../../services/log')
    const before = dumpLog().length
    expect(resolveTargetRenderer('从来没注册过的形')).toBeUndefined()
    expect(resolveTargetRenderer('从来没注册过的形')).toBeUndefined()
    const added = dumpLog().slice(before).filter(r => r.ns === 'search.targets')
    // 一张列表里二十条同 kind 的结果不该刷二十行日志。
    expect(added.length).toBe(1)
    expect(added[0].level).toBe('warn')
  })
})

describe('六种渲染器:徽与落点', () => {
  it('chat:徽走字典;落点是进会话(没有 messageId)', () => {
    const renderer = resolveTargetRenderer('chat')!
    expect(renderer.badge(row('chat', { sessionId: 's1' }))).toEqual({ labelKey: 'search.badgeSession' })
    const ctx = spyContext()
    renderer.activate(row('chat', { sessionId: 's1' }), ctx)
    expect(ctx.calls).toEqual(['enter:s1:'])
  })

  it('chat:payload 上带 messageId 时一起递下去(预览那一行指着第一条用户消息)', () => {
    const ctx = spyContext()
    resolveTargetRenderer('chat')!.activate(row('chat', { sessionId: 's1', messageId: 'm2' }), ctx)
    expect(ctx.calls).toEqual(['enter:s1:m2'])
  })

  it('message:落点必带 messageId —— 那正是「点了能滚到那条消息」的全部依据', () => {
    const ctx = spyContext()
    resolveTargetRenderer('message')!.activate(row('message', { sessionId: 's1', messageId: 'm9' }), ctx)
    expect(ctx.calls).toEqual(['enter:s1:m9'])
  })

  it('file:徽是**数据**(扩展名),不是文案;落点是打开路径', () => {
    const renderer = resolveTargetRenderer('file')!
    expect(renderer.badge(row('file', { filePath: 'a/b/c.ts' }))).toEqual({ text: 'TS' })
    // 没有扩展名就把整个名字大写 —— 不造「未知」这种文案。
    expect(renderer.badge(row('file', { filePath: 'a/notebook' }))).toEqual({ text: 'NOTEBOOK' })
    const ctx = spyContext()
    renderer.activate(row('file', { filePath: 'a/b/c.ts', line: 12 }), ctx)
    expect(ctx.calls).toEqual(['open:a/b/c.ts:12'])
  })

  it('daily:两形一个 kind —— 有 actionId 走动作口,没有就当文件打开', () => {
    const renderer = resolveTargetRenderer('note')!
    const ctx = spyContext()
    renderer.activate(row('note', { filePath: '/n/2026-09-05.md' }), ctx)
    renderer.activate(row('note', { filePath: '', actionId: 'create-daily' }), ctx)
    expect(ctx.calls).toEqual(['open:/n/2026-09-05.md:', 'run:create-daily'])
  })

  it('prompt / action:落点都是动作口(它们没有「去处」)', () => {
    const ctx = spyContext()
    resolveTargetRenderer('prompt')!.activate(row('prompt', { promptId: 'p1' }), ctx)
    resolveTargetRenderer('action')!.activate(row('action', { actionId: 'new-chat' }), ctx)
    expect(ctx.calls).toEqual(['run:p1', 'run:new-chat'])
  })

  it('payload 形不对(插件能力给了别的东西)= 什么都不做,不抛也不乱跳', () => {
    const ctx = spyContext()
    for (const kind of targetRendererKinds()) {
      resolveTargetRenderer(kind)!.activate(row(kind, null), ctx)
      resolveTargetRenderer(kind)!.activate(row(kind, { 什么都没有: 1 }), ctx)
    }
    expect(ctx.calls).toEqual([])
  })
})

/**
 * 续搜(S4b,§4.6)。「以谁为词、落到哪个 facet 键、跳到哪一类」由**这一类自己的
 * 渲染模块**答 —— 面板的骨架一个能力 id 都不认识,这几条用例守的正是那件事。
 */
describe('续搜:范围片与枢轴由渲染器自报', () => {
  it('message:只有范围片(会话),片上的字取行尾出处', () => {
    const renderer = resolveTargetRenderer('message')!
    const hit: SearchRow = {
      ...row('message', { sessionId: 's1', messageId: 'm9' }),
      origin: { kind: 'path', path: '那间会话' },
    }
    expect(renderer.continuations?.(hit)).toEqual([
      { kind: 'scope', labelKey: 'search.continueInSession', chip: { key: 'sessionId', value: 's1', label: '那间会话' } },
    ])
  })

  it('message:出处给不出名字时片退到 sessionId —— 画一个 id 比画一颗没字的片诚实', () => {
    const renderer = resolveTargetRenderer('message')!
    const hit: SearchRow = {
      ...row('message', { sessionId: 's1', messageId: 'm9' }),
      origin: { kind: 'path', path: '' },
    }
    expect(renderer.continuations?.(hit)[0]).toMatchObject({ chip: { label: 's1' } })
  })

  it('chat:两条 —— 范围片(词留着)与枢轴「它的消息」(换档 + 清词)', () => {
    const renderer = resolveTargetRenderer('chat')!
    const hit: SearchRow = { ...row('chat', { sessionId: 's1' }), text: '一间会话' }
    const out = renderer.continuations?.(hit) ?? []
    expect(out.map(c => c.kind)).toEqual(['scope', 'pivot'])
    // 枢轴 = capability + query + filters 三格一起换(§4.6 结论 2)。
    expect(out[1]).toEqual({
      kind: 'pivot',
      labelKey: 'search.pivotSessionMessages',
      capability: 'messages',
      query: '',
      chip: { key: 'sessionId', value: 's1', label: '一间会话' },
    })
  })

  it('file:枢轴的种子词是**文件名**不是整条路径(人在对话里说的是文件名)', () => {
    const renderer = resolveTargetRenderer('file')!
    const out = renderer.continuations?.(row('file', { filePath: '/repo/a/model-registry.ts' })) ?? []
    expect(out[0]).toMatchObject({ kind: 'pivot', query: 'model-registry.ts' })
    expect(out[1]).toMatchObject({ kind: 'scope', chip: { key: 'dir', value: '/repo/a' } })
  })

  it('file:路径没有目录段时不给范围片 —— 「在根目录内搜」不是一句有意义的话', () => {
    const renderer = resolveTargetRenderer('file')!
    const out = renderer.continuations?.(row('file', { filePath: 'a.ts' })) ?? []
    expect(out.map(c => c.kind)).toEqual(['pivot'])
  })

  it('prompt / action / daily 不提供续搜 —— 缺席就是「这一类没有下一步」', () => {
    for (const kind of ['prompt', 'action', 'note']) {
      expect(resolveTargetRenderer(kind)!.continuations).toBeUndefined()
    }
  })
})
