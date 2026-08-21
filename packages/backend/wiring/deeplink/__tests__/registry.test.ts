/**
 * H4 深链动作注册表 —— 装配层(声明门 / 归属 / 超时 / 熔断 / 拆除)。
 *
 * 验收的重点全在**确认之后那一步**:一个动作可以被注册,不代表它可以被调用;
 * 可以被调用,不代表它可以永远慢下去。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CORE_PLUGIN_FAILURE_THRESHOLD,
  PLUGIN_PERMISSION_DEEPLINK_HANDLE,
  PLUGIN_REGISTRY_POLICY,
} from '@onething/core/plugins'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-deeplink-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const bus = { emitGlobal: () => {}, onGlobal: () => () => {}, onAnySession: () => () => {} }

async function load() {
  vi.resetModules()
  const [api, registry, health, logging] = await Promise.all([
    import('../../plugins/api.js'),
    import('../registry.js'),
    import('@onething/runtime/plugins/health'),
    // `vi.resetModules()` 之后每次 load 都是一份新的 logging 单例 —— 捕获必须从
    // **同一份**里拿,否则收的是别的 root(L4)。
    import('../../logging/index.js'),
  ])
  registry.resetPluginDeepLinkActionsForTests()
  return { api, registry, health, logging }
}

function makeApi(
  mods: Awaited<ReturnType<typeof load>>,
  pluginId: string,
  permissions: string[],
) {
  return mods.api.createPluginAPI(pluginId, bus as never, {} as never, {
    declaredPermissions: permissions,
  })
}

describe('H4 deep link actions — 声明门', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('registers an action under a namespaced address', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'translator', [PLUGIN_PERMISSION_DEEPLINK_HANDLE])

    api.registerDeepLinkAction({
      name: 'translate',
      title: 'Translate the selection',
      handler: () => ({ notice: 'done' }),
    })

    // 与 registerTool / registerIMConnector 同构:插件占不到一个全局名字。
    expect(mods.registry.listPluginDeepLinkActions().map(info => info.address))
      .toEqual(['plugin:translator:translate'])
    expect(mods.registry.describePluginDeepLinkAction('translator', 'translate'))
      .toMatchObject({ title: 'Translate the selection', degraded: false })
  })

  it('refuses an undeclared plugin — structured rejection, no breaker', async () => {
    const mods = await load()
    const logs = mods.logging.collectLogRecordsForTests()
    const { api, state } = makeApi(mods, 'sneaky', [])

    const release = api.registerDeepLinkAction({
      name: 'run',
      title: 'Run it',
      handler: () => {},
    })

    expect(mods.registry.listPluginDeepLinkActions()).toEqual([])
    // noop 退订:插件调它不该炸。
    expect(() => release()).not.toThrow()
    expect(logs.messages().some(msg => msg.includes(PLUGIN_PERMISSION_DEEPLINK_HANDLE)))
      .toBe(true)
    // **不计熔断** —— manifest 笔误不该连坐插件的工具/命令/面板。
    expect(state.disposing).not.toBe(true)
    expect(mods.health.isPluginSurfaceDegraded('sneaky', 'deeplink:plugin:sneaky:run')).toBe(false)
    logs.stop()
  })

  it('refuses an illegal action name even when declared', async () => {
    const mods = await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { api } = makeApi(mods, 'p', [PLUGIN_PERMISSION_DEEPLINK_HANDLE])

    api.registerDeepLinkAction({ name: 'Translate This', title: 'x', handler: () => {} })
    api.registerDeepLinkAction({ name: '', title: 'x', handler: () => {} })
    api.registerDeepLinkAction({ name: 'ok', title: '', handler: () => {} })

    expect(mods.registry.listPluginDeepLinkActions()).toEqual([])
  })
})

describe('H4 deep link actions — 派发口', () => {
  it('hands the handler exactly { text, params }', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'trans', [PLUGIN_PERMISSION_DEEPLINK_HANDLE])
    const seen: unknown[] = []
    api.registerDeepLinkAction({
      name: 'translate',
      title: 'Translate',
      handler: ctx => { seen.push(ctx); return { notice: 'translated' } },
    })

    const outcome = await mods.registry.invokePluginDeepLinkAction('trans', 'translate', {
      text: 'bonjour',
      params: { to: 'zh' },
    })

    expect(outcome).toEqual({ ok: true, notice: 'translated' })
    expect(seen).toEqual([{ text: 'bonjour', params: { to: 'zh' } }])
  })

  it('refuses an address nobody registered —说得清地失败,不抛错', async () => {
    const mods = await load()
    const outcome = await mods.registry.invokePluginDeepLinkAction('nobody', 'nothing', {
      text: '',
      params: {},
    })
    expect(outcome).toEqual({ ok: false, reason: 'not-registered', detail: expect.any(String) })
  })

  it('times out a handler that never settles, and bills it', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'slow', [PLUGIN_PERMISSION_DEEPLINK_HANDLE])
    api.registerDeepLinkAction({
      name: 'hang',
      title: 'Hang',
      handler: () => new Promise(() => {}),
    })

    const outcome = await mods.registry.invokePluginDeepLinkAction('slow', 'hang', {
      text: '', params: {}, timeoutMs: 10,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('failed')
    expect(outcome.detail).toMatch(/timed out/)
  })

  it('degrades THIS action after repeated failures — 不连坐插件其余能力', async () => {
    const mods = await load()
    const { api } = makeApi(mods, 'flaky', [PLUGIN_PERMISSION_DEEPLINK_HANDLE])
    api.registerDeepLinkAction({
      name: 'boom',
      title: 'Boom',
      handler: () => { throw new Error('nope') },
    })
    api.registerDeepLinkAction({
      name: 'fine',
      title: 'Fine',
      handler: () => ({ notice: 'ok' }),
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
      await mods.registry.invokePluginDeepLinkAction('flaky', 'boom', { text: '', params: {} })
    }

    // 坏的那一个灰了 —— 确认卡据此显示"暂时不可用",而不是让用户确认一次空转。
    expect(mods.registry.describePluginDeepLinkAction('flaky', 'boom')?.degraded).toBe(true)
    const blocked = await mods.registry.invokePluginDeepLinkAction('flaky', 'boom', { text: '', params: {} })
    expect(blocked).toMatchObject({ ok: false, reason: 'degraded' })

    // 同一个插件的另一个动作照常 —— 降级的粒度是动作,不是插件。
    expect(mods.registry.describePluginDeepLinkAction('flaky', 'fine')?.degraded).toBe(false)
    await expect(mods.registry.invokePluginDeepLinkAction('flaky', 'fine', { text: '', params: {} }))
      .resolves.toEqual({ ok: true, notice: 'ok' })
  })
})

describe('H4 deep link actions — 拆除', () => {
  it('unregisters on release and on dispose, and the label matches the behaviour', async () => {
    const mods = await load()
    const { api, state } = makeApi(mods, 'trans', [PLUGIN_PERMISSION_DEEPLINK_HANDLE])

    const release = api.registerDeepLinkAction({ name: 'a', title: 'A', handler: () => {} })
    api.registerDeepLinkAction({ name: 'b', title: 'B', handler: () => {} })
    expect(mods.registry.listPluginDeepLinkActions()).toHaveLength(2)

    release()
    expect(mods.registry.listPluginDeepLinkActions().map(i => i.name)).toEqual(['b'])

    // 插件自己不调 release 也要拆干净 —— 拆除不建立在插件守规矩上。
    mods.api.disposePlugin(state)
    expect(mods.registry.listPluginDeepLinkActions()).toEqual([])

    // 标签必须与行为绑定(R7 第一版正是在这里说了谎)。
    expect(PLUGIN_REGISTRY_POLICY['deep-link-action'].teardown).toBe('fail-open')
    const afterTeardown = await mods.registry.invokePluginDeepLinkAction('trans', 'a', { text: '', params: {} })
    expect(afterTeardown).toMatchObject({ ok: false, reason: 'not-registered' })
  })

  it('states honestly that the pilot carries no production traffic yet', async () => {
    const policy = PLUGIN_REGISTRY_POLICY['deep-link-action']
    expect(policy.hasProductionTraffic).toBe(false)
    expect(policy.trafficNote).toContain('ask')
  })
})
