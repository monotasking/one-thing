/**
 * 用户 10-07 拍定的那条(第④步批 4):插件按 `plugin-settings.json` 里存的开关运行,**没有开关记录的已装插件按关闭处理**。
 * 内置插件不受影响(缺省照旧开)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-default-enabled-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(() => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const pluginsDir = path.join(storeRoot, 'plugins')
const devDir = path.join(storeRoot, 'plugins-dev')

function seedLedgerPlugin(name: string): void {
  const dir = path.join(pluginsDir, 'node_modules', name)
  fs.mkdirSync(dir, { recursive: true })
  const ledgerPath = path.join(pluginsDir, 'package.json')
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { dependencies: {} }
  ledger.dependencies[name] = 'file:x'
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name, description: 'fixture' }))
  fs.writeFileSync(path.join(dir, 'plugin-entry.js'), 'export default function () {}\n')
}

function writeSettings(enabled: Record<string, boolean> | undefined): void {
  const file = path.join(storeRoot, 'plugin-settings.json')
  if (enabled === undefined) fs.rmSync(file, { force: true })
  else fs.writeFileSync(file, JSON.stringify({ enabled }))
}

beforeEach(() => {
  fs.rmSync(pluginsDir, { recursive: true, force: true })
  fs.rmSync(devDir, { recursive: true, force: true })
  seedLedgerPlugin('never-toggled')
  seedLedgerPlugin('turned-on')
  seedLedgerPlugin('turned-off')
  fs.mkdirSync(devDir, { recursive: true })
  fs.writeFileSync(path.join(devDir, 'dev-script.js'), 'export default function () {}\n')
})

describe('插件开关:没有记录 = 关(用户插件),内置照旧开', () => {
  it('npm 账本插件与 plugins-dev 脚本:没记录的关、记了 true 的开、记了 false 的关;内置 log-monitor 开', async () => {
    writeSettings({ 'turned-on': true, 'turned-off': false })
    const { scanPlugins, USER_PLUGIN_ENABLED_WHEN_UNRECORDED } = await import('../plugin-disk-loader.js')
    expect(USER_PLUGIN_ENABLED_WHEN_UNRECORDED).toBe(false)
    const byId = new Map(scanPlugins().map(def => [def.id, def]))
    expect(byId.get('never-toggled')?.enabled).toBe(false)
    expect(byId.get('turned-on')?.enabled).toBe(true)
    expect(byId.get('turned-off')?.enabled).toBe(false)
    expect(byId.get('dev-script')?.enabled).toBe(false)
    expect(byId.get('log-monitor')?.source).toBe('builtin')
    expect(byId.get('log-monitor')?.enabled).toBe(true)
  })

  it('整个 plugin-settings.json 都没有时:用户插件全关,内置开', async () => {
    writeSettings(undefined)
    const { scanPlugins } = await import('../plugin-disk-loader.js')
    const defs = scanPlugins()
    expect(defs.filter(def => def.source !== 'builtin').every(def => def.enabled === false)).toBe(true)
    expect(defs.find(def => def.id === 'log-monitor')?.enabled).toBe(true)
  })
})
