/**
 * R6 验收:插件流状态。
 *
 * 本期的核心不是"能显示一行字",是**宿主兜底的生命周期**:插件 show 之后可能
 * 抛错、超时、被熔断、被停用、或者干脆忘了 clear —— 任何一种都会在用户的对话里
 * 留下一个永远转圈的状态,而用户没有任何办法让它消失。所以正确性不能建立在
 * "插件会守规矩"上,验收也就主要打在"不守规矩时会怎样"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CORE_PLUGIN_STATUS_MAX_PER_PLUGIN,
  CORE_PLUGIN_STATUS_MAX_SESSIONS,
  CORE_PLUGIN_STATUS_THROTTLE_MS,
  CorePluginStatusRegistry,
  PLUGIN_STATUS_PART_TYPE,
} from '@onething/core/plugins'
import { SESSION_STREAM_TERMINAL_EVENTS, isSessionStreamTerminalEvent } from '@shared/events/session-events'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-status-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

/**
 * 内置插件 id —— 从装配层的注册处现取(与 R0 守卫同一个事实源)。
 */
function listBuiltinPluginIds(): string[] {
  const loaderPath = fileURLToPath(new URL('../builtin/index.ts', import.meta.url))
  const dir = path.dirname(loaderPath)
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.ts') && name !== 'index.ts')
    .map(name => name.replace(/\.ts$/, ''))
}

describe('R6 status registry — 格子语义与清扫', () => {
  let registry: CorePluginStatusRegistry
  let clock: number

  beforeEach(() => {
    clock = 1_000_000
    // 频控按时间判定 —— 用可控时钟,不靠真实等待。
    registry = new CorePluginStatusRegistry({ now: () => clock })
  })

  it('treats (pluginId, id) as a cell: a repeat show updates the label', () => {
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'scan', label: 'Scanning 1/40' }))
      .toEqual({ type: PLUGIN_STATUS_PART_TYPE, pluginId: 'p', id: 'scan', label: 'Scanning 1/40' })
    registry.show({ pluginId: 'p', sessionId: 's', id: 'scan', label: 'Scanning 2/40' })
    registry.show({ pluginId: 'p', sessionId: 's', id: 'scan', label: 'Scanning 3/40' })

    // 一个每秒汇报进度的插件不该在气泡里堆出几百行。
    expect(registry.list('s')).toMatchObject([
      { pluginId: 'p', sessionId: 's', id: 'scan', label: 'Scanning 3/40' },
    ])
  })

  it('keeps two plugins and two ids apart', () => {
    registry.show({ pluginId: 'a', sessionId: 's', id: 'x', label: 'A x' })
    registry.show({ pluginId: 'b', sessionId: 's', id: 'x', label: 'B x' })
    registry.show({ pluginId: 'a', sessionId: 's', id: 'y', label: 'A y' })
    expect(registry.list('s')).toHaveLength(3)
  })

  it('rejects junk without throwing — a bad label must not fail the plugin call', () => {
    expect(registry.show({ pluginId: '', sessionId: 's', id: 'x', label: 'l' })).toBeNull()
    expect(registry.show({ pluginId: 'p', sessionId: '', id: 'x', label: 'l' })).toBeNull()
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: '', label: 'l' })).toBeNull()
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label: '   ' })).toBeNull()
    expect(registry.size()).toBe(0)
  })

  it('quotas per plugin, not per session — one runaway plugin must not lock the others out', () => {
    for (let i = 0; i < CORE_PLUGIN_STATUS_MAX_PER_PLUGIN; i += 1) {
      clock += CORE_PLUGIN_STATUS_THROTTLE_MS
      expect(registry.show({ pluginId: 'greedy', sessionId: 's', id: `i${i}`, label: 'x' })).not.toBeNull()
    }
    // 到顶之后这个插件的新增被挡。
    expect(registry.show({ pluginId: 'greedy', sessionId: 's', id: 'overflow', label: 'x' })).toBeNull()

    // **别的插件照样挂得上** —— 按会话配额的话它一条也挂不上,而 show 只返回
    // null 不抛,受害的插件根本无从感知。
    clock += CORE_PLUGIN_STATUS_THROTTLE_MS
    expect(registry.show({ pluginId: 'polite', sessionId: 's', id: 'x', label: 'x' })).not.toBeNull()

    // 已挂着的更新永远放行。
    clock += CORE_PLUGIN_STATUS_THROTTLE_MS
    expect(registry.show({ pluginId: 'greedy', sessionId: 's', id: 'i0', label: 'updated' })).not.toBeNull()
    expect(registry.list('s').find(record => record.id === 'i0')?.label).toBe('updated')
  })

  it('refuses a session with no running stream — status lives inside a bubble', () => {
    const warnings: string[] = []
    const gated = new CorePluginStatusRegistry({
      isStreaming: sessionId => sessionId === 'live',
      warn: message => warnings.push(message),
      now: () => clock,
    })

    expect(gated.show({ pluginId: 'p', sessionId: 'live', id: 'x', label: 'l' })).not.toBeNull()
    // 没有流 = 没有气泡。放行的话,那条 content:part 在 renderer 侧解析不出
    // messageId,会落进待发队列并贴到**下一条**毫不相干的消息上。
    expect(gated.show({ pluginId: 'p', sessionId: 'idle', id: 'x', label: 'l' })).toBeNull()
    expect(gated.size()).toBe(1)
    // 一次性告警,不刷屏。
    expect(warnings.filter(w => w.includes('no active stream'))).toHaveLength(1)
    gated.show({ pluginId: 'p', sessionId: 'idle', id: 'y', label: 'l' })
    expect(warnings.filter(w => w.includes('no active stream'))).toHaveLength(1)
  })

  it('caps the number of tracked sessions so show(randomUUID()) cannot grow it without bound', () => {
    for (let i = 0; i < CORE_PLUGIN_STATUS_MAX_SESSIONS; i += 1) {
      expect(registry.show({ pluginId: 'p', sessionId: `s${i}`, id: 'x', label: 'l' })).not.toBeNull()
    }
    // 每一个新会话 id 还会在 EventBus 里长出一个永不回收的环形缓冲。
    expect(registry.show({ pluginId: 'p', sessionId: 'one-too-many', id: 'x', label: 'l' })).toBeNull()
    expect(registry.sessionCount()).toBe(CORE_PLUGIN_STATUS_MAX_SESSIONS)
  })

  it('rejects ids that are unusable as a ledger key, a DOM key, or a payload', () => {
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'a b', label: 'l' })).toBeNull()
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'x'.repeat(200), label: 'l' })).toBeNull()
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'ok.id:1-2_x', label: 'l' })).not.toBeNull()
  })

  it('emits nothing when the label has not changed (pure dedupe)', () => {
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label: 'same' })).not.toBeNull()
    clock += 10_000
    // 汇报进度的插件绝大多数调用其实是同一句话 —— 每一句都发就会冲掉
    // EventBus 的环形缓冲,而 SSE 断线重连正是拿它做 ?after= 重放。
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label: 'same' })).toBeNull()
  })

  it('merges a burst and still delivers the final label (leading + trailing)', () => {
    expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label: '1/40' })).not.toBeNull()

    // 窗口内的变化只更账不投递。
    for (const label of ['2/40', '3/40', '4/40']) {
      clock += 10
      expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label })).toBeNull()
    }
    expect(registry.hasPending()).toBe(true)

    // trailing flush 把**最后一条**补出去 —— 最终状态是唯一必须送达的那条
    // (R5 的 panel-refresh 犯过同一个错,这里不再犯第二次)。
    clock += CORE_PLUGIN_STATUS_THROTTLE_MS
    const flushed = registry.flushPending()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toMatchObject({ sessionId: 's', part: { label: '4/40' } })
    expect(registry.hasPending()).toBe(false)
  })

  it('clear returns a cleared part once, and nothing the second time', () => {
    registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label: 'l' })
    expect(registry.clear({ pluginId: 'p', sessionId: 's', id: 'x' })).toMatchObject({ cleared: true, id: 'x' })
    expect(registry.clear({ pluginId: 'p', sessionId: 's', id: 'x' })).toBeNull()
  })

  it('sweeps a whole session and reports every part that has to be taken down', () => {
    registry.show({ pluginId: 'a', sessionId: 's1', id: 'x', label: 'l' })
    registry.show({ pluginId: 'b', sessionId: 's1', id: 'y', label: 'l' })
    registry.show({ pluginId: 'a', sessionId: 's2', id: 'z', label: 'l' })

    const swept = registry.clearSession('s1')
    expect(swept.map(part => part.id).sort()).toEqual(['x', 'y'])
    expect(swept.every(part => part.cleared)).toBe(true)
    // 别的会话不受影响。
    expect(registry.list('s2')).toHaveLength(1)
  })

  it('sweeps a plugin across every session and says which session each came from', () => {
    registry.show({ pluginId: 'a', sessionId: 's1', id: 'x', label: 'l' })
    registry.show({ pluginId: 'a', sessionId: 's2', id: 'y', label: 'l' })
    registry.show({ pluginId: 'b', sessionId: 's1', id: 'z', label: 'l' })

    const swept = registry.clearPlugin('a')
    // 撤下事件必须投回**原会话** —— 过线的 part 里没有会话地址,所以这里要带上。
    expect(swept.map(entry => entry.sessionId).sort()).toEqual(['s1', 's2'])
    expect(registry.list('s1')).toMatchObject([
      { pluginId: 'b', sessionId: 's1', id: 'z', label: 'l' },
    ])
  })

  it('takes the terminal-event list from the single shared authority', () => {
    // 这份名单曾被手抄在五处。上一版的守卫是同义反复(把常量钉在它自己的字面量
    // 上),加第四种终止事件时它照样是绿的 —— 那正是 §5.5 第 6 条刚立规矩要禁的
    // "白名单补集"。现在名单只有一份,且与三个终止事件接口由类型断言绑死。
    expect([...SESSION_STREAM_TERMINAL_EVENTS]).toEqual(['stream:complete', 'stream:error', 'stream:aborted'])
    for (const type of SESSION_STREAM_TERMINAL_EVENTS) expect(isSessionStreamTerminalEvent(type)).toBe(true)
    expect(isSessionStreamTerminalEvent('stream:start')).toBe(false)

    // 跨文件:曾经的手抄点现在都必须从 shared 取,不许再出现字面量三连。
    const handCopied = /'stream:complete'\s*,\s*'stream:error'\s*,\s*'stream:aborted'|'stream:complete'\s*\|\|[^\n]*'stream:aborted'/
    // renderer/stores/voice.ts 曾在名单里,随 Vue 宿主于 2026-09-04 退役删除。
    for (const relative of [
      '../../../../onething-runtime/src/collab/typing.ts',
    ]) {
      const source = fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8')
      expect(source, `${relative} must not re-list the terminal events`).not.toMatch(handCopied)
      expect(source, `${relative} must derive from the shared authority`).toMatch(/SESSION_STREAM_TERMINAL_EVENTS|isSessionStreamTerminalEvent/)
    }
  })
})

describe('R6 status — 装配层接线', () => {
  async function loadStatus() {
    const module = await import('@onething/runtime/plugins/status-bound')
    module.resetPluginStatusHostForTests()
    const emitted: Array<{ sessionId: string; event: any }> = []
    module.configurePluginStatusHost({
      emitSessionEvent: (sessionId, event) => { emitted.push({ sessionId, event }) },
    })
    return { module, emitted }
  }

  it('delivers a status over the existing content:part rail, not a new one', async () => {
    const { module, emitted } = await loadStatus()
    module.getPluginStatusRegistry().show({ pluginId: 'p', sessionId: 's', id: 'x', label: 'Working' })
    module.emitPluginStatusPart('s', { type: PLUGIN_STATUS_PART_TYPE, pluginId: 'p', id: 'x', label: 'Working' })

    // 走既有轨道 = desktop 的 IPCBridge 与 web 的 SSE 双扇出都是免费的。
    expect(emitted).toEqual([
      { sessionId: 's', event: { type: 'content:part', part: { type: 'plugin-status', pluginId: 'p', id: 'x', label: 'Working' } } },
    ])
  })

  it('force-sweeps a session and emits a cleared part for each survivor', async () => {
    const { module, emitted } = await loadStatus()
    const registry = module.getPluginStatusRegistry()
    registry.show({ pluginId: 'p', sessionId: 's', id: 'a', label: 'l' })
    registry.show({ pluginId: 'q', sessionId: 's', id: 'b', label: 'l' })
    emitted.length = 0

    await module.sweepPluginStatusForSession('s')

    expect(emitted).toHaveLength(2)
    expect(emitted.every(entry => entry.event.part.cleared)).toBe(true)
    expect(registry.size()).toBe(0)
  })

  it('sweeps BEFORE the terminal event is committed — otherwise cleared lands nowhere', async () => {
    const { module, emitted } = await loadStatus()
    const interceptors: Array<(event: any, sessionId: string) => Promise<any>> = []
    const unsubscribe = module.subscribePluginStatusSweep({
      intercept: (handler: any) => { interceptors.push(handler); return () => {} },
    })

    module.getPluginStatusRegistry().show({ pluginId: 'p', sessionId: 's', id: 'x', label: 'Working' })
    emitted.length = 0

    // 插件在 show 之后抛错,永远没走到 clear。
    // 拦截器跑在 commit 与 fan-out **之前** —— 等它 resolve 时 cleared 已经过线,
    // 而终止事件还没有。事后观察者做不到这一点:终止事件先到,renderer 自己把
    // transient 扫干净,后到的 cleared 落在一条已经收尾的消息上,宿主清扫空转。
    for (const intercept of interceptors) await intercept({ type: 'stream:error' }, 's')

    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.part).toMatchObject({ id: 'x', cleared: true })
    expect(module.getPluginStatusRegistry().size()).toBe(0)
    unsubscribe()
  })

  it('ignores non-terminal events so a mid-stream chunk does not wipe live statuses', async () => {
    const { module, emitted } = await loadStatus()
    const interceptors: Array<(event: any, sessionId: string) => Promise<any>> = []
    module.subscribePluginStatusSweep({
      intercept: (handler: any) => { interceptors.push(handler); return () => {} },
    })
    module.getPluginStatusRegistry().show({ pluginId: 'p', sessionId: 's', id: 'x', label: 'Working' })
    emitted.length = 0

    for (const intercept of interceptors) {
      await intercept({ type: 'content:part' }, 's')
      await intercept({ type: 'stream:start' }, 's')
    }

    expect(emitted).toHaveLength(0)
    expect(module.getPluginStatusRegistry().size()).toBe(1)
  })

  it('sweeps a deleted session — it may never reach a stream ending at all', async () => {
    const { module, emitted } = await loadStatus()
    const globals = new Map<string, (envelope: any) => void>()
    module.subscribePluginStatusSweep({
      intercept: () => () => {},
      onGlobal: (type: string, handler: (envelope: any) => void) => {
        globals.set(type, handler)
        return () => {}
      },
    })
    module.getPluginStatusRegistry().show({ pluginId: 'p', sessionId: 's', id: 'x', label: 'Working' })
    emitted.length = 0

    globals.get('session:deleted')?.({ event: { type: 'session:deleted', sessionId: 's' } })
    await new Promise(resolve => setImmediate(resolve))

    expect(module.getPluginStatusRegistry().size()).toBe(0)
  })

  it('schedules a trailing flush so a merged burst still delivers its final label', async () => {
    // 被测过的是 core 的 flushPending();**把它排上时间轴**的那段(220ms 定时器)
    // 此前零用例 —— 与 R5 panel-refresh 同一个位置的教训:合并窗的价值全在
    // trailing 那一半,而那一半最容易写漏。
    vi.useFakeTimers()
    try {
      const { module, emitted } = await loadStatus()
      const registry = module.getPluginStatusRegistry()

      // 第一条直接过线(leading)。
      const first = registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label: '1/40' })
      expect(first).not.toBeNull()
      module.emitPluginStatusPart('s', first!)
      emitted.length = 0

      // 窗口内连发:core 压住,只更账。
      for (const label of ['2/40', '3/40', '4/40']) {
        expect(registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label })).toBeNull()
        module.notePluginStatusPending()
      }
      expect(emitted).toHaveLength(0)

      // 定时器到点 → 补发**最后一条**。
      await vi.advanceTimersByTimeAsync(300)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].event.part).toMatchObject({ id: 'x', label: '4/40' })

      // 没有新变化时不该无限自排。
      await vi.advanceTimersByTimeAsync(1000)
      expect(emitted).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let one session ending swallow another session pending final label', async () => {
    /*
     * 补发定时器曾经是**模块级单个**,而清扫是按会话触发的 —— 会话 A 结束时
     * 一句 clearTrailingFlush() 会把会话 B 被合并窗压住的最终状态一起吞掉。
     * 两个会话同时在跑是常态(群聊、并行回合),不是边角情况。
     */
    vi.useFakeTimers()
    try {
      const { module, emitted } = await loadStatus()
      const registry = module.getPluginStatusRegistry()
      const interceptors: Array<(event: any, sessionId: string) => Promise<any>> = []
      module.subscribePluginStatusSweep({ intercept: (handler: any) => { interceptors.push(handler); return () => {} } })

      // 两个会话各挂一条,各自再压住一次变化。
      for (const sessionId of ['s-a', 's-b']) {
        const first = registry.show({ pluginId: 'p', sessionId, id: 'x', label: '1/9' })
        module.emitPluginStatusPart(sessionId, first!)
        registry.show({ pluginId: 'p', sessionId, id: 'x', label: '9/9' })
        module.notePluginStatusPending()
      }
      emitted.length = 0

      // 会话 A 结束。
      for (const intercept of interceptors) await intercept({ type: 'stream:complete' }, 's-a')
      await vi.advanceTimersByTimeAsync(1000)

      const forA = emitted.filter(entry => entry.sessionId === 's-a')
      const forB = emitted.filter(entry => entry.sessionId === 's-b')

      // A:只有清扫发出的 cleared,没有迟到的 9/9。
      expect(forA).toHaveLength(1)
      expect(forA[0].event.part).toMatchObject({ cleared: true })
      // B:**最终状态照常送达** —— 这正是上一版会吞掉的那条。
      expect(forB).toHaveLength(1)
      expect(forB[0].event.part).toMatchObject({ label: '9/9' })
      expect(forB[0].event.part.cleared).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending trailing flush when the stream ends', async () => {
    // 终止事件之后再补一条状态,等于在一条已经收尾的消息上重新点亮。
    vi.useFakeTimers()
    try {
      const { module, emitted } = await loadStatus()
      const registry = module.getPluginStatusRegistry()
      const interceptors: Array<(event: any, sessionId: string) => Promise<any>> = []
      module.subscribePluginStatusSweep({ intercept: (handler: any) => { interceptors.push(handler); return () => {} } })

      const first = registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label: '1/40' })
      module.emitPluginStatusPart('s', first!)
      registry.show({ pluginId: 'p', sessionId: 's', id: 'x', label: '2/40' })
      module.notePluginStatusPending()
      emitted.length = 0

      for (const intercept of interceptors) await intercept({ type: 'stream:complete' }, 's')
      await vi.advanceTimersByTimeAsync(1000)

      // 只该有清扫发出的那条 cleared,没有迟到的 2/40。
      expect(emitted).toHaveLength(1)
      expect(emitted[0].event.part).toMatchObject({ cleared: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('unsubscribes everything on detach so a restart does not stack interceptors', async () => {
    const { module } = await loadStatus()
    let interceptorCount = 0
    let globalCount = 0
    const detach = module.subscribePluginStatusSweep({
      intercept: () => { interceptorCount += 1; return () => { interceptorCount -= 1 } },
      onGlobal: () => { globalCount += 1; return () => { globalCount -= 1 } },
    })
    expect(interceptorCount).toBe(1)
    expect(globalCount).toBe(1)
    detach()
    expect(interceptorCount).toBe(0)
    expect(globalCount).toBe(0)
  })
})

describe('R6 status — 插件 API 面', () => {
  async function createApi(pluginId = 'demo') {
    const status = await import('@onething/runtime/plugins/status-bound')
    status.resetPluginStatusHostForTests()
    const emitted: Array<{ sessionId: string; event: any }> = []
    status.configurePluginStatusHost({
      emitSessionEvent: (sessionId, event) => { emitted.push({ sessionId, event }) },
    })
    const { createPluginAPI, disposePlugin } = await import('../api.js')
    const bus = { emitGlobal: () => {}, onGlobal: () => () => {}, onAnySession: () => () => {} }
    const created = createPluginAPI(pluginId, bus as never, {} as never)
    return { ...created, emitted, status, disposePlugin }
  }

  it('shows and clears through the plugin-facing api', async () => {
    const { api, emitted } = await createApi()
    api.status.show('s1', { id: 'scan', label: 'Scanning…' })
    api.status.clear('s1', 'scan')

    expect(emitted.map(entry => entry.event.part)).toEqual([
      { type: 'plugin-status', pluginId: 'demo', id: 'scan', label: 'Scanning…' },
      { type: 'plugin-status', pluginId: 'demo', id: 'scan', label: 'Scanning…', cleared: true },
    ])
  })

  it('drops a status shown after dispose — nobody would ever come to clean it', async () => {
    const { api, state, emitted, disposePlugin } = await createApi()
    disposePlugin(state)
    emitted.length = 0

    api.status.show('s1', { id: 'late', label: 'Too late' })

    expect(emitted).toHaveLength(0)
  })

  it('sweeps a disabled plugin out of every session it was showing in', async () => {
    const { api, state, emitted, status, disposePlugin } = await createApi('demo')
    api.status.show('s1', { id: 'x', label: 'Working' })
    api.status.show('s2', { id: 'y', label: 'Working' })
    emitted.length = 0

    // 停用 / 熔断走的就是这条路。只等流结束是不够的 —— 那些会话可能几小时后才结束。
    disposePlugin(state)

    expect(emitted).toHaveLength(2)
    expect(emitted.map(entry => entry.sessionId).sort()).toEqual(['s1', 's2'])
    expect(emitted.every(entry => entry.event.part.cleared)).toBe(true)
    expect(status.getPluginStatusRegistry().size()).toBe(0)
  })
})

describe('R6 验收口径 — 新增插件状态零改动 shared 契约', () => {
  it('carries exactly one generic plugin-status member and knows no plugin by name', () => {
    const contractPath = fileURLToPath(new URL('../../../../shared/ipc/chat.ts', import.meta.url))
    const source = fs.readFileSync(contractPath, 'utf-8')

    // 一个泛化成员。按插件加类型的话,每来一个插件就要改一次这个文件 ——
    // 那正是 soul-memory 让宿主改了 16,989 行的那种形状。
    const members = source.match(/type:\s*'plugin-status'/g) ?? []
    expect(members).toHaveLength(1)

    // 契约面不认识任何具体插件。这条断言就是"零改动"验收的可执行形式:
    // 谁想给自家插件加一个专属状态类型,这里会立刻变红。
    const codeLines = source
      .split('\n')
      .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n')
    // 名单从**内置插件目录**现取,不写死 —— 写死的话新增一个内置插件时守卫
    // 照样是绿的,而它守的恰恰是"契约不得认识任何具体插件"。
    for (const pluginId of listBuiltinPluginIds()) {
      expect(codeLines, `the shared ContentPart contract must not know "${pluginId}"`).not.toContain(pluginId)
    }
    // 已退役的名字同样不许回潮。
    expect(codeLines).not.toContain('soul-memory')
  })
})

describe('R6 验收 — log-monitor 示范(流内形态)', () => {
  it('shows progress from inside a tool, under one id, and clears in finally', async () => {
    const { registerOnethingLogMonitorStatusDemo } = await import('@onething/runtime/plugins')

    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-status-demo-'))
    fs.writeFileSync(path.join(logDir, 'agent-2026-08-07.log'), 'a\n')
    fs.writeFileSync(path.join(logDir, 'agent-2026-08-06.log'), 'bb\n')
    fs.writeFileSync(path.join(logDir, 'notes.txt'), 'ignored')

    try {
      const tools = new Map<string, any>()
      const shown: Array<{ id: string; label: string }> = []
      const cleared: string[] = []

      registerOnethingLogMonitorStatusDemo({
        registerTool: (tool: any) => tools.set(tool.name, tool),
        status: {
          show: (_sessionId: string, status: { id: string; label: string }) => shown.push(status),
          clear: (_sessionId: string, id: string) => cleared.push(id),
        },
      } as never, { logDir })

      // 工具执行**天然发生在流内** —— 这正是把示范从斜杠命令挪过来的理由:
      // 斜杠命令走 executePluginCommand 直调 IPC,不在任何 stream 里。
      const result = await tools.get('scan_log_files').execute({}, { sessionId: 's1' })

      expect(new Set(shown.map(entry => entry.id))).toEqual(new Set(['scan']))
      expect(shown.length).toBeGreaterThan(1)
      expect(shown[shown.length - 1].label).toContain('2/2')
      expect(cleared).toEqual(['scan'])
      expect(result.title).toContain('Scanned 2 log file(s)')
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })

  it('leaves no residue when the tool throws before clear', async () => {
    const { registerOnethingLogMonitorStatusDemo } = await import('@onething/runtime/plugins')
    const status = await import('@onething/runtime/plugins/status-bound')
    status.resetPluginStatusHostForTests()
    const emitted: Array<{ sessionId: string; event: any }> = []
    status.configurePluginStatusHost({
      emitSessionEvent: (sessionId, event) => { emitted.push({ sessionId, event }) },
    })

    const tools = new Map<string, any>()
    const registry = status.getPluginStatusRegistry()
    registerOnethingLogMonitorStatusDemo({
      registerTool: (tool: any) => tools.set(tool.name, tool),
      status: {
        show: (sessionId: string, entry: { id: string; label: string }) => {
          const part = registry.show({ pluginId: 'log-monitor', sessionId, ...entry })
          if (part) status.emitPluginStatusPart(sessionId, part)
        },
        // 故意**不实现** clear:模拟"插件挂了/忘了收尾"。
        clear: () => {},
      },
    } as never, { logDir: '/no/such/dir' })

    // 目录不存在 → readdirSync 抛 → finally 里那次 clear 是 no-op。
    await expect(tools.get('scan_log_files').execute({}, { sessionId: 's1' })).rejects.toThrow()
    expect(registry.size()).toBe(1)

    // 宿主在终止事件之前强制清扫 —— 这就是 R6 的全部要点。
    await status.sweepPluginStatusForSession('s1')
    expect(registry.size()).toBe(0)
    expect(emitted[emitted.length - 1].event.part).toMatchObject({ cleared: true })
  })
})
