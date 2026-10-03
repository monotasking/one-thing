/**
 * P3 市场 IPC 适配器:索引快照与本机安装态/版本兼容的 join 是主进程的事,
 * renderer 只渲染 —— 所以 join 语义(徽标/置灰/缓存过期)全部钉在这里。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CorePluginMarketIndex } from '@onething/backend/plugin/plugin-contract'
import { getOnethingPluginMarketForIpc, type OnethingPluginMarketSnapshot } from '../ipc-operations.js'

const INDEX: CorePluginMarketIndex = {
  version: 1,
  plugins: [
    {
      id: 'plan-status',
      pkg: '@onething-plugins/plan-status',
      version: '2.0.0',
      description: 'status chip',
      author: 'onething',
      tarballUrl: 'https://releases.example/plan-status-2.0.0.tgz',
      integrity: 'sha512-AAA',
      contributes: { uiSlots: [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }] },
    },
    {
      id: 'fresh-plugin',
      pkg: '@onething-plugins/fresh-plugin',
      version: '1.0.0',
      minAppVersion: '9.9.9',
      tarballUrl: 'https://releases.example/fresh-plugin-1.0.0.tgz',
    },
    {
      // 索引写坏:id 与 pkg 去 scope 不一致 —— join 会错,整条滤掉。
      id: 'plan-status',
      pkg: '@onething-plugins/something-else',
      version: '3.0.0',
      tarballUrl: 'https://releases.example/impostor-3.0.0.tgz',
    },
  ],
}

function createManager(installed: Array<{ id: string; version: string }>) {
  return {
    getPlugins: vi.fn(() => installed.map(p => ({
      definition: {
        id: p.id,
        source: 'user',
        manifest: { name: p.id, version: p.version },
        enabled: true,
        dirPath: `/plugins/node_modules/@onething-plugins/${p.id}`,
      },
      loaded: true,
      commands: [],
    }))),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
    refreshPlugins: vi.fn(),
    getPluginCommands: vi.fn(() => new Map()),
    getCommandHandler: vi.fn(() => undefined),
  }
}

function snapshotOf(partial: Partial<OnethingPluginMarketSnapshot>): OnethingPluginMarketSnapshot {
  return { index: null, fetchedAt: null, stale: false, error: null, ...partial }
}

describe('市场 IPC 适配器(P3)', () => {
  it('join 安装态:同版已装/旧版有更新/未装;id 与 pkg 不符的条目被滤掉', async () => {
    const manager = createManager([
      { id: 'plan-status', version: '1.0.0' }, // 索引 2.0.0 → 有更新
    ])
    const getMarketSnapshot = vi.fn(async () => snapshotOf({ index: INDEX, fetchedAt: 1000 }))

    const result = await getOnethingPluginMarketForIpc({
      manager, getMarketSnapshot, appVersion: '9.9.9',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    // 坏条目被滤:三条索引只剩两条,且 id 唯一。
    expect(result.entries.map(e => e.id)).toEqual(['plan-status', 'fresh-plugin'])
    const plan = result.entries[0]
    expect(plan.installedVersion).toBe('1.0.0')
    expect(plan.hasUpdate).toBe(true)
    expect(plan.contributes).toBeDefined()
    expect(plan.integrity).toBe('sha512-AAA')
    const fresh = result.entries[1]
    expect(fresh.installedVersion).toBeNull()
    expect(fresh.hasUpdate).toBe(false)
    expect(result.fetchedAt).toBe(1000)
    expect(result.stale).toBe(false)
  })

  it('minAppVersion 不足 → versionBlockedReason 带版本号;appVersion 省略 → 不置灰', async () => {
    const manager = createManager([])
    const getMarketSnapshot = async () => snapshotOf({ index: INDEX })

    const blocked = await getOnethingPluginMarketForIpc({ manager, getMarketSnapshot, appVersion: '1.4.0' })
    expect(blocked.success).toBe(true)
    if (!blocked.success) return
    expect(blocked.entries[1].versionBlockedReason).toBe('requires app >= 9.9.9 (current 1.4.0)')
    // 无 minAppVersion 的条目不受影响
    expect(blocked.entries[0].versionBlockedReason).toBeNull()

    const skipped = await getOnethingPluginMarketForIpc({ manager, getMarketSnapshot })
    expect(skipped.success && skipped.entries[1].versionBlockedReason).toBeNull()
  })

  it('拉取失败但有缓存 = success + stale + 失败原因(断网容忍的 UI 数据源)', async () => {
    const manager = createManager([])
    const getMarketSnapshot = async () => snapshotOf({ index: INDEX, fetchedAt: 500, stale: true, error: 'HTTP 503' })

    const result = await getOnethingPluginMarketForIpc({ manager, getMarketSnapshot })
    expect(result).toMatchObject({ success: true, stale: true, fetchedAt: 500, error: 'HTTP 503' })
    expect(result.success && result.entries.length).toBe(2)
  })

  it('连缓存都没有 = 真空失败:success:false + entries 空 + 错误透传', async () => {
    const manager = createManager([])
    const getMarketSnapshot = async () => snapshotOf({ error: 'HTTP 503' })

    const result = await getOnethingPluginMarketForIpc({ manager, getMarketSnapshot })
    expect(result).toEqual({ success: false, entries: [], fetchedAt: null, stale: false, error: 'HTTP 503' })
  })

  it('快照口未注入 = 市场不可用(形状与失败契约一致)', async () => {
    const manager = createManager([])
    const result = await getOnethingPluginMarketForIpc({ manager })
    expect(result).toMatchObject({ success: false, entries: [], stale: false })
    if (!result.success) expect(result.error).toContain('unavailable')
  })

  it('refresh 语义透传给快照口(true = 强制重拉)', async () => {
    const manager = createManager([])
    const getMarketSnapshot = vi.fn(async () => snapshotOf({ index: INDEX }))
    await getOnethingPluginMarketForIpc({ manager, getMarketSnapshot, refresh: true })
    expect(getMarketSnapshot).toHaveBeenCalledWith({ refresh: true })
    await getOnethingPluginMarketForIpc({ manager, getMarketSnapshot })
    expect(getMarketSnapshot).toHaveBeenLastCalledWith({ refresh: false })
  })
})
