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
    domain: 'session',
    text: '一行',
    code: false,
    origin: { kind: 'time', time: '刚刚' },
    target: { kind, payload },
    tier: 'title',
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
      ['action', 'chat', 'daily', 'file', 'message', 'prompt'],
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
    const renderer = resolveTargetRenderer('daily')!
    const ctx = spyContext()
    renderer.activate(row('daily', { filePath: '/n/2026-09-05.md' }), ctx)
    renderer.activate(row('daily', { filePath: '', actionId: 'create-daily' }), ctx)
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
