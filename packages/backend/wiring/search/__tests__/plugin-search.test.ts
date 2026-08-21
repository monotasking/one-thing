/**
 * M2 搜索供给方 —— 装配层(注册面 + 并发聚合 + 超时即弃 + 熔断跳过 + 点击派发)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-search-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CorePluginSearchProviderRegistration } from '@onething/core/plugins'
import { createPluginAPI } from '../../../plugins/api.js'
import { resetPluginRuntimeHealthForTests } from '../../../plugins/health.js'
import {
  decodePluginSearchAction,
  invokePluginSearchAction,
  listPluginSearchProviders,
  registerPluginSearchProvider,
  resetPluginSearchProvidersForTests,
  searchPluginProviders,
} from '../plugin-search-registry.js'

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const bus = { emitGlobal: () => {}, onGlobal: () => () => {}, onAnySession: () => () => {} }
const engine = {}

function provider(
  id: string,
  label: string,
  search: CorePluginSearchProviderRegistration['search'],
  onAction?: CorePluginSearchProviderRegistration['onAction'],
): CorePluginSearchProviderRegistration {
  return { id, label, search, onAction }
}

beforeEach(() => {
  resetPluginSearchProvidersForTests()
  resetPluginRuntimeHealthForTests()
})

describe('M2 — 注册面与声明门', () => {
  it('registers a provider only when the plugin declared search:provide', () => {
    const declared = createPluginAPI('declared', bus as never, engine as never, {
      declaredPermissions: ['search:provide'],
    } as never)
    declared.api.registerSearchProvider(provider('emoji', 'Emoji', () => []))
    expect(listPluginSearchProviders()).toEqual([{ pluginId: 'declared', providerId: 'emoji', label: 'Emoji' }])

    const undeclared = createPluginAPI('undeclared', bus as never, engine as never)
    undeclared.api.registerSearchProvider(provider('emoji', 'Emoji', () => []))
    // 未声明 = 拒绝注册,注册表里没有它。
    expect(listPluginSearchProviders().some(p => p.pluginId === 'undeclared')).toBe(false)
  })

  it('empties the registry on teardown (release)', () => {
    const declared = createPluginAPI('gone', bus as never, engine as never, {
      declaredPermissions: ['search:provide'],
    } as never)
    const release = declared.api.registerSearchProvider(provider('x', 'X', () => []))
    expect(listPluginSearchProviders()).toHaveLength(1)
    release()
    expect(listPluginSearchProviders()).toEqual([])
  })
})

describe('M2 — 并发聚合、超时即弃、熔断跳过', () => {
  it('merges results from multiple providers, grouped and routable', async () => {
    registerPluginSearchProvider('p1', provider('emoji', 'Emoji', () => [
      { id: 'fire', title: '🔥 fire', actionId: '🔥', icon: 'emoji' },
    ]))
    registerPluginSearchProvider('p2', provider('kaomoji', 'Kaomoji', () => [
      { id: 'shrug', title: '¯\\_(ツ)_/¯', actionId: 'shrug' },
    ]))

    const results = await searchPluginProviders('f', { limit: 10 })
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.type).toBe('plugin')
      expect(r.actionId?.startsWith('plugin-search:')).toBe(true)
      expect(r.id.startsWith('plugin:')).toBe(true)
    }
    // 分组可辨:group = provider label。
    expect(results.map(r => r.group).sort()).toEqual(['Emoji', 'Kaomoji'])
  })

  it('drops a result that carries a boundary-crossing field, keeps the clean one', async () => {
    registerPluginSearchProvider('p', provider('sneaky', 'Sneaky', () => [
      { id: 'ok', title: 'Clean' },
      // filePath 是越界字段 —— 整条丢弃(不进结果集)。
      { id: 'evil', title: 'Evil', filePath: '/etc/passwd' } as never,
    ]))
    const results = await searchPluginProviders('x', { limit: 10 })
    expect(results.map(r => r.title)).toEqual(['Clean'])
  })

  it('drops a timed-out provider without blocking the fast one', async () => {
    let slowResolved = false
    registerPluginSearchProvider('slow', provider('slow', 'Slow', async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      slowResolved = true
      return [{ id: 's', title: 'Slow result' }]
    }))
    registerPluginSearchProvider('fast', provider('fast', 'Fast', () => [{ id: 'f', title: 'Fast result' }]))

    const results = await searchPluginProviders('x', { limit: 10, timeoutMs: 40 })
    expect(results.map(r => r.title)).toEqual(['Fast result'])
    expect(slowResolved).toBe(false)
  })

  it('skips a provider after it trips the breaker, others keep working', async () => {
    let brokenCalls = 0
    registerPluginSearchProvider('broken', provider('broken', 'Broken', () => {
      brokenCalls += 1
      throw new Error('boom')
    }))
    registerPluginSearchProvider('healthy', provider('healthy', 'Healthy', () => [{ id: 'h', title: 'Healthy' }]))

    // 连败驱动它过阈值(阈值无关写法):每次调用坏供给方弃、健康供给方照常。
    for (let i = 0; i < 5; i += 1) {
      const results = await searchPluginProviders('x', { limit: 10 })
      expect(results.map(r => r.title)).toEqual(['Healthy'])
    }
    // 降级之后计数已停止增长(聚合器在调用之前就跳过它)。
    const callsAtPlateau = brokenCalls
    expect(callsAtPlateau).toBeGreaterThanOrEqual(1)
    expect(callsAtPlateau).toBeLessThanOrEqual(5)

    const after = await searchPluginProviders('x', { limit: 10 })
    expect(after.map(r => r.title)).toEqual(['Healthy'])
    // search 不再被调 —— 一个坏供给方挡不住整条搜索。
    expect(brokenCalls).toBe(callsAtPlateau)
  })

  it('returns only built-ins (nothing) when no providers are registered', async () => {
    expect(await searchPluginProviders('x', { limit: 10 })).toEqual([])
  })
})

describe('M2 — 点击派发回插件自己的 action', () => {
  it('routes a click to the provider onAction with the decoded actionId', async () => {
    const seen: string[] = []
    registerPluginSearchProvider('p', provider(
      'emoji',
      'Emoji',
      () => [{ id: 'fire', title: '🔥', actionId: '🔥' }],
      (ctx) => { seen.push(ctx.actionId) },
    ))
    const [result] = await searchPluginProviders('f', { limit: 10 })
    expect(decodePluginSearchAction(result.actionId!)).toEqual({
      pluginId: 'p',
      providerId: 'emoji',
      actionId: '🔥',
    })

    const handled = await invokePluginSearchAction(result.actionId!, { query: 'f' })
    expect(handled).toBe(true)
    expect(seen).toEqual(['🔥'])
  })

  it('returns false for an unknown or non-plugin action', async () => {
    expect(await invokePluginSearchAction('switch-session:123', {})).toBe(false)
    expect(await invokePluginSearchAction('plugin-search:ghost:none:x', {})).toBe(false)
  })
})
