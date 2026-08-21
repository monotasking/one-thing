/**
 * 消息作用域状态 —— **API 面**验收(plugin-message-state-2026-08)。
 *
 * message-state.test.ts 打的是 core 存储本身;这一份打的是插件真正摸到的那条
 * 线:`api.storage.message(sid, mid)` → 宿主家目录 → 真 EventBus 级联。三件
 * 只有在这一层才看得见的事:
 *  1. **lifetime 闸门是从 manifest 投影下来的** —— 声明 persistent 才落盘,
 *     不声明就是纯内存;闸门读错的后果是"插件以为存住了,重启全丢",
 *     而两边单测各自都是绿的;
 *  2. **坐标随调用递交** —— scoped 视图把 (sid, mid) 交给宿主,宿主结构性归账;
 *  3. **级联挂在真总线上** —— message:deleted / session:deleted 走 EventBus,
 *     且订阅的生命周期与插件 state 对齐(拆除即退订)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-msg-api-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  // 与 event-routing.test.ts 同一条收尾:让在飞的写落完再删根。
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

async function load() {
  const [{ EventBus }, api] = await Promise.all([
    import('../../events/event-bus.js'),
    import('../api.js'),
  ])
  return { EventBus, createPluginAPI: api.createPluginAPI, disposePlugin: api.disposePlugin }
}

function streamEngineStub() {
  return { steerMessage() {}, followUpMessage() {} }
}

const PERSISTENT_SLOT = {
  anchor: 'message.footer',
  id: 'tps',
  label: 'TPS',
  lifetime: 'persistent' as const,
}
const EPHEMERAL_SLOT = { anchor: 'message.footer', id: 'tps', label: 'TPS' }

function recordFile(pluginId: string, sessionId: string, messageId: string): string {
  return path.join(storeRoot, 'plugins', pluginId, 'message-state', sessionId, `${messageId}.json`)
}

describe('api.storage.message —— scoped 视图', () => {
  it('写读一致、坐标不串台、缺席给 fallback', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('scoped-view', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })

    plugin.api.storage.message('s1', 'm1').writeJson({ v: 1, tps: 34.2 })
    plugin.api.storage.message('s1', 'm2').writeJson({ v: 1, tps: 9.9 })
    plugin.api.storage.message('s2', 'm1').writeJson({ v: 1, tps: 77 })

    expect(plugin.api.storage.message('s1', 'm1').readJson()).toEqual({ v: 1, tps: 34.2 })
    expect(plugin.api.storage.message('s1', 'm2').readJson()).toEqual({ v: 1, tps: 9.9 })
    // 同 messageId 落在不同会话 —— 坐标是二元的,不是一元的。
    expect(plugin.api.storage.message('s2', 'm1').readJson()).toEqual({ v: 1, tps: 77 })
    expect(plugin.api.storage.message('s1', 'nope').exists()).toBe(false)
    expect(plugin.api.storage.message('s1', 'nope').readJson({ fallback: true })).toEqual({ fallback: true })

    disposePlugin(plugin.state)
  })

  it('两个插件互不可见 —— 各自的家目录各记各的账', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const a = createPluginAPI('tenant-a', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })
    const b = createPluginAPI('tenant-b', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })

    a.api.storage.message('s1', 'm1').writeJson({ owner: 'a' })
    expect(b.api.storage.message('s1', 'm1').exists()).toBe(false)
    b.api.storage.message('s1', 'm1').writeJson({ owner: 'b' })
    expect(a.api.storage.message('s1', 'm1').readJson()).toEqual({ owner: 'a' })
    expect(fs.existsSync(recordFile('tenant-a', 's1', 'm1'))).toBe(true)
    expect(fs.existsSync(recordFile('tenant-b', 's1', 'm1'))).toBe(true)

    disposePlugin(a.state)
    disposePlugin(b.state)
  })
})

describe('lifetime 闸门(manifest → 宿主投影)', () => {
  it('persistent:落盘到家目录,重载(新实例)后水合回来', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const first = createPluginAPI('gate-persistent', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })
    first.api.storage.message('s1', 'm1').writeJson({ tps: 42 })
    expect(fs.existsSync(recordFile('gate-persistent', 's1', 'm1'))).toBe(true)
    disposePlugin(first.state)

    // 重载 = 新一份 API(插件重启/宿主重启的等价物)
    const second = createPluginAPI('gate-persistent', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })
    expect(second.api.storage.message('s1', 'm1').readJson()).toEqual({ tps: 42 })
    disposePlugin(second.state)
  })

  it('不声明 lifetime(默认 ephemeral):不落盘,新实例读不到', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const first = createPluginAPI('gate-default', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [EPHEMERAL_SLOT],
    })
    first.api.storage.message('s1', 'm1').writeJson({ tps: 42 })
    // 内存里读得到 —— ephemeral 不是"不能用",是"重启即丢"。
    expect(first.api.storage.message('s1', 'm1').readJson()).toEqual({ tps: 42 })
    expect(fs.existsSync(recordFile('gate-default', 's1', 'm1'))).toBe(false)
    disposePlugin(first.state)

    const second = createPluginAPI('gate-default', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [EPHEMERAL_SLOT],
    })
    expect(second.api.storage.message('s1', 'm1').exists()).toBe(false)
    disposePlugin(second.state)
  })

  it('未知的未来 lifetime 值天然降级为非持久(闸门读 === persistent)', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('gate-unknown', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [{ ...EPHEMERAL_SLOT, lifetime: 'synced' as never }],
    })
    plugin.api.storage.message('s1', 'm1').writeJson({ tps: 1 })
    expect(fs.existsSync(recordFile('gate-unknown', 's1', 'm1'))).toBe(false)
    disposePlugin(plugin.state)
  })

  it('多槽插件:任一槽声明 persistent 即开闸(闸门是插件级)', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('gate-mixed', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [
        { anchor: 'composer.above', id: 'hint', label: 'Hint' },
        PERSISTENT_SLOT,
      ],
    })
    plugin.api.storage.message('s1', 'm1').writeJson({ tps: 1 })
    expect(fs.existsSync(recordFile('gate-mixed', 's1', 'm1'))).toBe(true)
    disposePlugin(plugin.state)
  })
})

describe('级联走真 EventBus', () => {
  it('message:deleted → 清该条(内存+磁盘),同会话其他条不动', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('cascade-message', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })
    plugin.api.storage.message('s1', 'm1').writeJson({ v: 1 })
    plugin.api.storage.message('s1', 'm2').writeJson({ v: 2 })

    await bus.emit('s1', { type: 'message:deleted', messageId: 'm1' } as never)

    expect(plugin.api.storage.message('s1', 'm1').exists()).toBe(false)
    expect(plugin.api.storage.message('s1', 'm2').exists()).toBe(true)
    expect(fs.existsSync(recordFile('cascade-message', 's1', 'm1'))).toBe(false)
    expect(fs.existsSync(recordFile('cascade-message', 's1', 'm2'))).toBe(true)

    disposePlugin(plugin.state)
  })

  it('session:deleted(全局)→ 清整个会话,其他会话不动', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('cascade-session', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })
    plugin.api.storage.message('s1', 'm1').writeJson({ v: 1 })
    plugin.api.storage.message('s2', 'm9').writeJson({ v: 9 })

    bus.emitGlobal({ type: 'session:deleted', sessionId: 's1' } as never)

    expect(plugin.api.storage.message('s1', 'm1').exists()).toBe(false)
    expect(plugin.api.storage.message('s2', 'm9').exists()).toBe(true)
    expect(fs.existsSync(path.join(storeRoot, 'plugins', 'cascade-session', 'message-state', 's1'))).toBe(false)
    expect(fs.existsSync(recordFile('cascade-session', 's2', 'm9'))).toBe(true)

    disposePlugin(plugin.state)
  })

  it('拆除即退订:已停用插件的存储不再被别人的删除事件搅动', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('cascade-unsub', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })
    plugin.api.storage.message('s1', 'm1').writeJson({ v: 1 })
    disposePlugin(plugin.state)

    await bus.emit('s1', { type: 'message:deleted', messageId: 'm1' } as never)

    // 订阅已退订 —— 磁盘上的归档物不该被一个已死插件的回调二次改写。
    expect(fs.existsSync(recordFile('cascade-unsub', 's1', 'm1'))).toBe(true)
  })
})

describe('拆除闩(§7.4)', () => {
  it('拆除后晚到的写当场抛(与 KV/storage 同规),且不复活家目录', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('late-write', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })
    plugin.api.storage.message('s1', 'm1').writeJson({ v: 1 })
    disposePlugin(plugin.state)

    // 写面抛:插件必须当场知道自己写空了(静默吞会让它以为存住了)。
    expect(() => plugin.api.storage.message('s1', 'm2').writeJson({ v: 2 })).toThrow(/disposed/)
    expect(fs.existsSync(recordFile('late-write', 's1', 'm2'))).toBe(false)
    // 归档物不被复活,已有记录原样在。
    expect(fs.existsSync(recordFile('late-write', 's1', 'm1'))).toBe(true)
  })

  it('拆除后的读不抛、给 fallback —— 渲染路径不能死在时序上', async () => {
    const { EventBus, createPluginAPI, disposePlugin } = await load()
    const bus = new EventBus()
    const plugin = createPluginAPI('late-read', bus as never, streamEngineStub() as never, {
      declaredUiSlots: [PERSISTENT_SLOT],
    })
    plugin.api.storage.message('s1', 'm1').writeJson({ v: 1 })
    disposePlugin(plugin.state)

    expect(plugin.api.storage.message('s1', 'm1').readJson({ gone: true })).toEqual({ gone: true })
    expect(plugin.api.storage.message('s1', 'm1').exists()).toBe(false)
  })
})
