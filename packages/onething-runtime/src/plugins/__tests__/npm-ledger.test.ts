/**
 * P1-2 验收:npm-ledger 扫描语义。
 *
 * 拍板(设计 §5):清单来源从"遍历 plugins/ 每个目录"换成
 * `plugins/package.json` 的 dependencies 账;普通依赖与插件共存于同一棵
 * node_modules(没有 plugin.json 就跳过)。**账是唯一入口**:2026-08-09 legacy
 * 清零之后,插件根下的手工目录(不论有没有 plugin.json)都不再是插件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createBuiltinPluginDefinitions,
  readPluginLedger,
  scanCorePlugins,
  unscopedPluginIdFromPackageName,
} from '@onething/core/plugins'

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-ledger-'))
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

/** 在 node_modules/<name>/ 下造一个最小可加载插件。 */
function makeNpmPlugin(pluginsDir: string, name: string, options: { version?: string; withManifest?: boolean } = {}): void {
  const dir = path.join(pluginsDir, 'node_modules', name)
  writeJson(path.join(dir, 'package.json'), { name, version: options.version ?? '1.0.0' })
  if (options.withManifest !== false) {
    writeJson(path.join(dir, 'plugin.json'), { name, description: 'demo' })
  }
  fs.writeFileSync(path.join(dir, 'plugin-entry.js'), 'export default function () {}\n')
}

function makeLedger(pluginsDir: string, dependencies: Record<string, string>): void {
  writeJson(path.join(pluginsDir, 'package.json'), {
    private: true,
    name: 'onething-installed-plugins',
    dependencies,
  })
}

describe('unscopedPluginIdFromPackageName', () => {
  it('单 scope 去前缀;无 scope 原样', () => {
    expect(unscopedPluginIdFromPackageName('@org/foo')).toBe('foo')
    expect(unscopedPluginIdFromPackageName('foo')).toBe('foo')
    expect(unscopedPluginIdFromPackageName('@org/foo-bar_baz')).toBe('foo-bar_baz')
  })
})

describe('readPluginLedger —— 账读的可信度', () => {
  it('脚手架不存在 = 可信的空账(还没装过 npm 插件)', () => {
    const plugins = tempRoot()
    const ledger = readPluginLedger(plugins)
    expect(ledger).toEqual({ trusted: true, entries: [] })
  })

  it('坏 JSON = 不可信,什么都不删(空账当真会把家目录全判成孤儿)', () => {
    const plugins = tempRoot()
    fs.writeFileSync(path.join(plugins, 'package.json'), '{not json')
    const ledger = readPluginLedger(plugins)
    expect(ledger.trusted).toBe(false)
    expect(ledger.entries).toEqual([])
    expect(ledger.reason).toContain('corrupt')
  })

  it('只收值为 string 的 dependencies 条目', () => {
    const plugins = tempRoot()
    writeJson(path.join(plugins, 'package.json'), {
      dependencies: { good: 'https://example/x.tgz', bad: 42 },
    })
    const ledger = readPluginLedger(plugins)
    expect(ledger.trusted).toBe(true)
    expect(ledger.entries).toEqual([{ name: 'good', spec: 'https://example/x.tgz' }])
  })
})

describe('scanCorePlugins(scanMode: npm-ledger)', () => {
  it('账内插件:版本以 node_modules 里 package.json 为准', () => {
    const plugins = tempRoot()
    makeLedger(plugins, { 'plan-status': 'https://example/plan-status-1.2.3.tgz' })
    makeNpmPlugin(plugins, 'plan-status', { version: '1.2.3' })

    const scanned = scanCorePlugins({
      builtinPlugins: [],
      pluginsDir: plugins,
      getEnabled: () => true,
      scanMode: 'npm-ledger',
    })

    expect(scanned).toHaveLength(1)
    expect(scanned[0].id).toBe('plan-status')
    expect(scanned[0].manifest.version).toBe('1.2.3')
    expect(scanned[0].dirPath).toBe(path.join(plugins, 'node_modules', 'plan-status'))
    expect(scanned[0].entryPath).toBe(path.join(plugins, 'node_modules', 'plan-status', 'plugin-entry.js'))
  })

  it('账内但包里没有 plugin.json = 普通依赖,与插件共存,跳过', () => {
    const plugins = tempRoot()
    makeLedger(plugins, { lodash: '^4.0.0', 'plan-status': 'file:///x.tgz' })
    makeNpmPlugin(plugins, 'lodash', { withManifest: false })
    makeNpmPlugin(plugins, 'plan-status')

    const scanned = scanCorePlugins({
      builtinPlugins: [],
      pluginsDir: plugins,
      getEnabled: () => true,
      scanMode: 'npm-ledger',
    })

    expect(scanned.map(p => p.id)).toEqual(['plan-status'])
  })

  it('scope 去前缀;两个 scope 同名 = 后到者被拒绝', () => {
    const plugins = tempRoot()
    makeLedger(plugins, {
      '@alpha/foo': 'https://example/a.tgz',
      '@beta/foo': 'https://example/b.tgz',
    })
    makeNpmPlugin(plugins, '@alpha/foo')
    makeNpmPlugin(plugins, '@beta/foo')

    const scanned = scanCorePlugins({
      builtinPlugins: [],
      pluginsDir: plugins,
      getEnabled: () => true,
      scanMode: 'npm-ledger',
    })

    expect(scanned.map(p => p.id)).toEqual(['foo'])
    expect(scanned[0].dirPath).toContain(path.join('node_modules', '@alpha', 'foo'))
  })

  it('账不可信 = 本轮 npm 扫描整体弃权(什么都不扫出来,也什么都不删)', () => {
    const plugins = tempRoot()
    fs.writeFileSync(path.join(plugins, 'package.json'), '{broken')
    makeNpmPlugin(plugins, 'plan-status')

    const scanned = scanCorePlugins({
      builtinPlugins: [],
      pluginsDir: plugins,
      getEnabled: () => true,
      scanMode: 'npm-ledger',
    })

    expect(scanned).toEqual([])
    // node_modules 原物未动
    expect(fs.existsSync(path.join(plugins, 'node_modules', 'plan-status', 'plugin.json'))).toBe(true)
  })

  it('内置插件与账内插件同 id = 内置赢', () => {
    const plugins = tempRoot()
    makeLedger(plugins, { '@org/log-monitor': 'https://example/x.tgz' })
    makeNpmPlugin(plugins, '@org/log-monitor')

    const builtin = createBuiltinPluginDefinitions([{
      id: 'log-monitor',
      manifest: { name: 'log-monitor', version: '0.0.0' },
      entry: () => {},
      enabled: true,
    }])

    const scanned = scanCorePlugins({
      builtinPlugins: builtin,
      pluginsDir: plugins,
      getEnabled: () => true,
      scanMode: 'npm-ledger',
    })

    expect(scanned).toHaveLength(1)
    expect(scanned[0].source).toBe('builtin')
  })

  it('账外的手工目录一律不加载 —— 有没有 plugin.json 都一样', () => {
    const plugins = tempRoot()
    makeLedger(plugins, {})
    // 曾经的 legacy 目录形态:有 plugin.json + entry,但不在账里。
    const strayDir = path.join(plugins, 'ui-demo')
    writeJson(path.join(strayDir, 'package.json'), { name: 'ui-demo', version: '0.1.0' })
    writeJson(path.join(strayDir, 'plugin.json'), { name: 'ui-demo' })
    fs.writeFileSync(path.join(strayDir, 'plugin-entry.js'), 'export default function () {}\n')
    // 纯数据家目录:无 plugin.json → 同样不是插件
    fs.mkdirSync(path.join(plugins, 'plan-status', 'storage'), { recursive: true })

    const scanned = scanCorePlugins({
      builtinPlugins: [],
      pluginsDir: plugins,
      getEnabled: () => true,
      scanMode: 'npm-ledger',
    })

    expect(scanned).toEqual([])
    // 不加载 ≠ 删掉:目录原地不动,交给人处置。
    expect(fs.existsSync(path.join(strayDir, 'plugin.json'))).toBe(true)
  })

  it('手工目录与账内插件同 id = 账内的那个照常加载,目录被忽略', () => {
    const plugins = tempRoot()
    makeLedger(plugins, { '@org/foo': 'https://example/x.tgz' })
    makeNpmPlugin(plugins, '@org/foo')
    const strayDir = path.join(plugins, 'foo')
    writeJson(path.join(strayDir, 'plugin.json'), { name: 'foo' })
    fs.writeFileSync(path.join(strayDir, 'plugin-entry.js'), 'export default function () {}\n')

    const scanned = scanCorePlugins({
      builtinPlugins: [],
      pluginsDir: plugins,
      getEnabled: () => true,
      scanMode: 'npm-ledger',
    })

    expect(scanned).toHaveLength(1)
    expect(scanned[0].dirPath).toContain('node_modules')
  })

  it('默认(directory)语义不受影响:仍遍历插件根,不读账', () => {
    const plugins = tempRoot()
    makeLedger(plugins, { 'npm-only': 'https://example/x.tgz' })
    makeNpmPlugin(plugins, 'npm-only')
    const dirPlugin = path.join(plugins, 'dir-plugin')
    writeJson(path.join(dirPlugin, 'plugin.json'), { name: 'dir-plugin' })
    fs.writeFileSync(path.join(dirPlugin, 'plugin-entry.js'), 'export default function () {}\n')

    const scanned = scanCorePlugins({
      builtinPlugins: [],
      pluginsDir: plugins,
      getEnabled: () => true,
    })

    // directory 模式只见插件根,不见 node_modules 里的 npm 插件
    expect(scanned.map(p => p.id)).toEqual(['dir-plugin'])
  })
})
