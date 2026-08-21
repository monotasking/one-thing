/**
 * R7 试点注册表:IM 连接器。
 *
 * 这是插件系统第一个对外开放的**既有注册表**。选它不是因为它最有用,是因为它
 * 形状最适配:候选五个里只有它自带退订函数(变量提供者恰恰相反 —— 它至今没有
 * unregister,原方案建议拿它当试点是选反了)。
 *
 * 验收的重点是**停用之后**:注册表回到基线、经该渠道的回复得到一个说得清的
 * 错误而不是静默丢消息、已有会话不受影响。拆除语义在策略表里声明为
 * `degrade-to-default`,这里验证实现与声明一致。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_REGISTRY_POLICY } from '@onething/core/plugins'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-connector-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

async function load() {
  vi.resetModules()
  const [api, registry] = await Promise.all([
    import('../api.js'),
    import('../../channel/connector-registry.js'),
  ])
  return { api, registry }
}

function fakeConnector(id: string, sent: string[]) {
  return {
    id,
    async sendReply(_target: unknown, payload: { text: string }) {
      sent.push(payload.text)
    },
    async normalizeIncoming(raw: unknown) {
      return {
        content: String((raw as { text?: string })?.text ?? ''),
        origin: { connector: id, conversationId: 'c1', userId: 'u1' } as never,
      }
    },
  }
}

const bus = { emitGlobal: () => {}, onGlobal: () => () => {}, onAnySession: () => () => {} }

describe('R7 IM connector — 开放一个既有注册表', () => {
  let sent: string[]

  beforeEach(() => {
    sent = []
  })

  it('routes real traffic through a plugin-registered connector', async () => {
    const { api, registry } = await load()
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)

    pluginApi.registerIMConnector(fakeConnector('fake-im', sent) as never)

    // id 带命名空间(与 registerTool 同构):插件不能占用一个全局 id。
    expect(registry.listIMConnectorIds()).toContain('plugin:chat-bridge:fake-im')
    expect(registry.listIMConnectorIds()).not.toContain('fake-im')
    expect(registry.getIMConnectorOwner('plugin:chat-bridge:fake-im')).toBe('chat-bridge')
    await registry.sendIMReply(
      { connector: 'plugin:chat-bridge:fake-im', conversationId: 'c1' } as never,
      { text: 'hello', sessionId: 's1', messageId: 'm1' },
    )
    expect(sent).toEqual(['hello'])

    api.disposePlugin(state)
  })

  it('degrades to default on disable: unregistered, and later replies fail loudly', async () => {
    const { api, registry } = await load()
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)
    pluginApi.registerIMConnector(fakeConnector('fake-im', sent) as never)

    // 停用 = dispose。声明的语义是 degrade-to-default。
    // 标签必须与实现一致:实现是 throw,所以标签是 fail-open。
    expect(PLUGIN_REGISTRY_POLICY['im-connector'].teardown).toBe('fail-open')
    api.disposePlugin(state)

    // 注册表回到基线 —— 拆除测试的判据。
    expect(registry.listIMConnectorIds()).not.toContain('plugin:chat-bridge:fake-im')

    // 之后的回复要**说得清地失败**,不是静默丢消息。
    await expect(registry.sendIMReply(
      { connector: 'plugin:chat-bridge:fake-im', conversationId: 'c1' } as never,
      { text: 'late', sessionId: 's1', messageId: 'm2' },
    )).rejects.toThrow(/not registered/)
    expect(sent).toEqual([])
  })

  it('does not need the plugin to call the returned unsubscribe', async () => {
    const { api, registry } = await load()
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)

    // 插件拿到退订函数但**不调**(忘了、或者抛在半路)。
    pluginApi.registerIMConnector(fakeConnector('forgetful', sent) as never)
    api.disposePlugin(state)

    // 拆除语义不建立在插件守规矩上 —— 这是整条战役的主线。
    expect(registry.listIMConnectorIds()).not.toContain('plugin:chat-bridge:forgetful')
  })

  it('is idempotent when the plugin does call unsubscribe as well', async () => {
    const { api, registry } = await load()
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)
    const release = pluginApi.registerIMConnector(fakeConnector('polite', sent) as never)

    release()
    expect(registry.listIMConnectorIds()).not.toContain('plugin:chat-bridge:polite')
    // 再调一次、再 dispose 一次都不该抛。
    expect(() => release()).not.toThrow()
    expect(() => api.disposePlugin(state)).not.toThrow()
  })

  it('namespaces per plugin so two plugins can use the same connector name', async () => {
    const { api, registry } = await load()
    const first = api.createPluginAPI('a', bus as never, {} as never)
    const second = api.createPluginAPI('b', bus as never, {} as never)

    first.api.registerIMConnector(fakeConnector('shared-name', sent) as never)
    second.api.registerIMConnector(fakeConnector('shared-name', sent) as never)

    // 两条渠道各自成立 —— 没有命名空间的话,B 会静默劫持 A 的渠道而 A 侧毫无察觉。
    expect(registry.listIMConnectorIds()).toEqual(
      expect.arrayContaining(['plugin:a:shared-name', 'plugin:b:shared-name']),
    )

    api.disposePlugin(first.state)
    expect(registry.listIMConnectorIds()).not.toContain('plugin:a:shared-name')
    expect(registry.listIMConnectorIds()).toContain('plugin:b:shared-name')

    api.disposePlugin(second.state)
    expect(registry.listIMConnectorIds()).not.toContain('plugin:b:shared-name')
  })

  it('refuses to overwrite an id that is already taken', async () => {
    const { registry } = await load()
    const connector = fakeConnector('taken', sent)
    registry.registerIMConnector(connector as never)

    // 退订按实例比对只防住"撤下别人的",不防"顶掉别人的" —— 这里补上后者。
    expect(() => registry.registerIMConnector(fakeConnector('taken', sent) as never))
      .toThrow(/already registered/)
  })

  it('reports a delivery failure to the breaker so the connector family has a real producer', async () => {
    const { api, registry } = await load()
    const failures: Array<{ pluginId: string; connectorId: string }> = []
    registry.configureIMConnectorHooks({
      onSendFailure: (pluginId: string, connectorId: string) => failures.push({ pluginId, connectorId }),
    })
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)
    pluginApi.registerIMConnector({
      id: 'flaky',
      sendReply: async () => { throw new Error('socket closed') },
      normalizeIncoming: async () => ({ content: '', origin: {} as never }),
    } as never)

    await expect(registry.sendIMReply(
      { connector: 'plugin:chat-bridge:flaky', conversationId: 'c1' } as never,
      { text: 'x', sessionId: 's1', messageId: 'm1' },
    )).rejects.toThrow('socket closed')

    // 运行期证据:没有它,connector 家族就只有注册期生产者。
    expect(failures).toEqual([{ pluginId: 'chat-bridge', connectorId: 'plugin:chat-bridge:flaky' }])
    api.disposePlugin(state)
  })

  it('blocks delivery once the connector surface is degraded — the badge must not lie', async () => {
    /*
     * 三个 degrade-surface 家族里,ui-request / plugin-request 被请求闸拦住,
     * 而 connector 此前没有对应的闸:连败降级之后照样每次进插件的 sendReply,
     * 只多一个写着 "switched off" 的假徽章 —— 与返工前批判的第一版形状完全相同。
     */
    const { api, registry } = await load()
    let delivered = 0
    const degraded = new Set<string>()
    registry.configureIMConnectorHooks({
      isSurfaceDegraded: (_pluginId: string, surface: string) => degraded.has(surface),
      describeDegradedSurface: () => '3 consecutive failures',
    })
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)
    pluginApi.registerIMConnector({
      id: 'wechat',
      sendReply: async () => { delivered += 1 },
      normalizeIncoming: async () => ({ content: '', origin: {} as never }),
    } as never)

    const target = { connector: 'plugin:chat-bridge:wechat', conversationId: 'c1' } as never
    await registry.sendIMReply(target, { text: 'ok', sessionId: 's', messageId: 'm' })
    expect(delivered).toBe(1)

    degraded.add('connector:plugin:chat-bridge:wechat')

    // 降级之后**不再进插件**,且错误要说清是降级而不是未注册
    // (两者的处置完全不同:一个等恢复,一个是配置错了)。
    await expect(registry.sendIMReply(target, { text: 'blocked', sessionId: 's', messageId: 'm2' }))
      .rejects.toThrow(/switched off after repeated failures.*3 consecutive failures/)
    expect(delivered).toBe(1)

    api.disposePlugin(state)
  })

  it('half-opens after a cooldown so a degraded channel is not a one-way door', async () => {
    /*
     * 请求通道那侧的逃生口是用户点 "Try once more"(bypassDegraded);渠道投递
     * 没人在旁边点按钮 —— 没有等价物的话,解除降级的唯一路径是投递成功,而闸
     * 就在投递之前:**一扇单向的死门**,接上 gateway 那天就是一条永久哑掉的渠道。
     */
    const { api, registry } = await load()
    let delivered = 0
    let probeAllowed = false
    registry.configureIMConnectorHooks({
      isSurfaceDegraded: () => true,
      describeDegradedSurface: () => 'broken',
      probeSurface: () => probeAllowed,
    })
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)
    pluginApi.registerIMConnector({
      id: 'wechat',
      sendReply: async () => { delivered += 1 },
      normalizeIncoming: async () => ({ content: '', origin: {} as never }),
    } as never)

    const target = { connector: 'plugin:chat-bridge:wechat', conversationId: 'c1' } as never

    // 冷却期内:拦住,插件不被进入。
    await expect(registry.sendIMReply(target, { text: 'x', sessionId: 's', messageId: 'm' })).rejects.toThrow(/switched off/)
    expect(delivered).toBe(0)

    // 冷却过后放行一次真投递 —— 成功则 onSendSuccess 解除降级。
    probeAllowed = true
    await registry.sendIMReply(target, { text: 'x', sessionId: 's', messageId: 'm2' })
    expect(delivered).toBe(1)

    api.disposePlugin(state)
  })

  it('refuses a connector with no id instead of registering an unaddressable one', async () => {
    const { api, registry } = await load()
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)
    const before = registry.listIMConnectorIds().length

    pluginApi.registerIMConnector({ sendReply: async () => {} } as never)

    expect(registry.listIMConnectorIds()).toHaveLength(before)
    api.disposePlugin(state)
  })

  it('ignores a registration attempted after teardown', async () => {
    const { api, registry } = await load()
    const { api: pluginApi, state } = api.createPluginAPI('chat-bridge', bus as never, {} as never)
    api.disposePlugin(state)

    // 拆除之后再注册 = 往一个没人再会来清扫的表里塞东西。
    pluginApi.registerIMConnector(fakeConnector('too-late', sent) as never)
    expect(registry.listIMConnectorIds()).not.toContain('plugin:chat-bridge:too-late')
  })
})
