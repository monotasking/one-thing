/**
 * 审查回归:install/update 的 catalog-changed 广播。
 *
 * core 的 installPlugin/updatePlugin 内部走 doRefreshPlugins()(单飞互斥的
 * 要求),不经过 runtime PluginManager 的 refreshPlugins() 覆盖 —— 广播
 * 曾经因此不会发生:新装/更新完的插件,主窗的面板入口与锚点块清单停在
 * 上一世。本文件钉住"装/更都会广播"。
 *
 * install.js 被 vi.mock 换掉:不起真 npm,但逼真模拟账/包两处落盘效果,
 * 于是 npm-ledger 扫描能在 doRefreshPlugins 里看见"装上的"插件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-catalog-broadcast-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const pluginsDir = path.join(storeRoot, 'plugins')

/** 逼真模拟 npm install/uninstall 的账与包;版本由 calls 表驱动。 */
function simulateNpmInstall(pkg: string, version: string): void {
  const dir = path.join(pluginsDir, 'node_modules', pkg)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version }))
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: pkg }))
  fs.writeFileSync(path.join(dir, 'plugin-entry.js'), 'export default function () {}\n')
  const ledgerPath = path.join(pluginsDir, 'package.json')
  const ledger = fs.existsSync(ledgerPath)
    ? JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as { dependencies?: Record<string, string> }
    : { private: true, name: 'onething-installed-plugins', dependencies: {} as Record<string, string> }
  ledger.dependencies = { ...ledger.dependencies, [pkg]: 'file:/fake-spec' }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2))
}

const installCalls: Array<{ pkg: string; spec: string }> = []
let installVersion = '1.0.0'

vi.mock('../install.js', async importOriginal => {
  const original = await importOriginal<typeof import('../install.js')>()
  return {
    ...original,
    installPluginPackage: async (_pluginsDir: string, input: { pkg: string; spec: string }) => {
      installCalls.push({ pkg: input.pkg, spec: input.spec })
      simulateNpmInstall(input.pkg, installVersion)
      return { ok: true, pluginId: input.pkg }
    },
    readInstalledPluginSpec: () => 'file:/old-spec',
    fetchPluginMarketIndex: async () => ({
      version: 1,
      plugins: [{ id: 'demo', pkg: 'demo', version: '2.0.0', tarballUrl: 'https://example/demo-2.0.0.tgz' }],
    }),
  }
})

const bus = {
  emitted: [] as Array<{ type?: string; pluginId?: string; kind?: string }>,
  emitGlobal(event: { type?: string; pluginId?: string; kind?: string }) {
    this.emitted.push(event)
  },
  onGlobal: () => () => {},
  onAnySession: () => () => {},
  intercept: () => () => {},
}

describe('install/update 的 catalog-changed 广播(审查回归)', () => {
  beforeEach(() => {
    bus.emitted.length = 0
    installCalls.length = 0
  })

  it('installPlugin 广播(面板入口与锚点清单不停在上一世);updatePlugin 同样广播', async () => {
    // 内置插件关掉:它们的真 entry 不该在这个测试里跑。
    const { writePluginSettingsFile, getCorePluginSettingsPath } = await import('@onething/core/plugins')
    writePluginSettingsFile(getCorePluginSettingsPath({ storePath: storeRoot }), {
      enabled: { 'log-monitor': false, 'note-skills': false },
    })
    const { PluginManager } = await import('../manager.js')
    const manager = new PluginManager()
    await manager.initialize({ eventBus: bus, streamEngine: {} })

    // ── install ──
    const installed = await manager.installPlugin({ pkg: 'demo', path: '/fake/demo' })
    expect(installed).toEqual({ success: true, pluginId: 'demo' })
    expect(
      bus.emitted.some(event => event.type === 'plugin:notification'
        && event.kind === 'catalog-changed'
        && event.pluginId === 'demo'),
      'installPlugin must broadcast catalog-changed — the main window panel catalog must not go stale',
    ).toBe(true)
    // 插件真的进表了(广播不是空响)
    expect(manager.getPlugins().some(info => info.definition.id === 'demo')).toBe(true)

    bus.emitted.length = 0
    // ── update(v1 → 索引 v2)──
    installVersion = '2.0.0'
    const updated = await manager.updatePlugin('demo')
    expect(updated).toEqual({ success: true, pluginId: 'demo', version: '2.0.0' })
    expect(
      bus.emitted.some(event => event.type === 'plugin:notification'
        && event.kind === 'catalog-changed'
        && event.pluginId === 'demo'),
      'updatePlugin must broadcast catalog-changed too',
    ).toBe(true)
    expect(manager.getPlugins().find(info => info.definition.id === 'demo')
      ?.definition.manifest.version).toBe('2.0.0')

    manager.shutdown()
  })
})
