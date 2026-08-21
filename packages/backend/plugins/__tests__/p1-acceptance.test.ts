/**
 * P1-6 验收:真 host 的孤儿收尸 + 真 npm 的全生命周期。
 *
 * 两层:
 *  - A 层(常驻):**真 PluginManager**(无参构造 = 真 host 全接线)的孤儿
 *    收尸 —— plugin-data 与家目录两个根的归档、legacy-backup 自排除、
 *    账本不可信整轮弃权。
 *  - B 层(ONETHING_E2E_NPM=1 才跑):**真 npm** 过生产适配器
 *    (runtime install.ts 的 runPluginNpm,非假 npm)—— 脚手架、
 *    file: 装 plan-status、postinstall 不执行(--ignore-scripts 的
 *    实证,不是参数断言)、卸载拆账拆包、配置家文件跨重装存活。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { writePluginSettingsFile, getCorePluginSettingsPath } from '@onething/core/plugins'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-p1-acceptance-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

function freshPluginsDir(name: string): string {
  const dir = path.join(storeRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function makeNpmPlugin(pluginsDir: string, pkg: string, version = '1.0.0'): void {
  const dir = path.join(pluginsDir, 'node_modules', pkg)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version }))
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: pkg }))
  fs.writeFileSync(path.join(dir, 'plugin-entry.js'), 'export default function () {}\n')
  fs.writeFileSync(path.join(pluginsDir, 'package.json'), JSON.stringify({
    private: true, name: 'onething-installed-plugins', dependencies: { [pkg]: `file:../fixtures/${pkg}` },
  }))
}

// ── A 层:真 host 的孤儿收尸 ──

describe('A:真 PluginManager 的孤儿收尸(两个根)', () => {
  it('家目录孤儿与 plugin-data 孤儿各进各的 legacy-backup;活插件与账外代码目录不动', async () => {
    process.env.ONETHING_STORE_PATH = freshPluginsDir('store-a1')
    const pluginsDir = path.join(process.env.ONETHING_STORE_PATH, 'plugins')
    const dataRoot = path.join(process.env.ONETHING_STORE_PATH, 'plugin-data')
    fs.mkdirSync(pluginsDir, { recursive: true })
    // 活的 npm 插件(过安全闸:userPluginCount > 0)
    makeNpmPlugin(pluginsDir, 'alive')
    // 家目录孤儿(纯数据,无主)
    fs.mkdirSync(path.join(pluginsDir, 'ghost-home', 'storage'), { recursive: true })
    fs.writeFileSync(path.join(pluginsDir, 'ghost-home', 'kv.json'), '{}')
    // plugin-data 孤儿(旧根遗留)
    fs.mkdirSync(path.join(dataRoot, 'ghost-data'), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'ghost-data', 'kv.json'), '{}')
    // 账外的手工代码目录(有 plugin.json):**不再被加载**(2026-08-09 legacy 清零),
    // 但也**不是家目录孤儿** —— 它不是宿主管的数据,不归档、不删,原地留给人处置。
    const strayDir = path.join(pluginsDir, 'stray-code')
    fs.mkdirSync(strayDir, { recursive: true })
    fs.writeFileSync(path.join(strayDir, 'plugin.json'), JSON.stringify({ name: 'stray-code' }))
    fs.writeFileSync(path.join(strayDir, 'plugin-entry.js'), 'export default function () {}\n')

    const { PluginManager } = await import('../manager.js')
    const manager = new PluginManager()
    await manager.refreshPlugins()

    // 家目录孤儿 → plugins/legacy-backup/
    expect(fs.existsSync(path.join(pluginsDir, 'ghost-home'))).toBe(false)
    const homeBackups = fs.readdirSync(path.join(pluginsDir, 'legacy-backup'))
    expect(homeBackups.some(entry => entry.startsWith('ghost-home-'))).toBe(true)
    // plugin-data 孤儿 → plugin-data/legacy-backup/
    expect(fs.existsSync(path.join(dataRoot, 'ghost-data'))).toBe(false)
    const dataBackups = fs.readdirSync(path.join(dataRoot, 'legacy-backup'))
    expect(dataBackups.some(entry => entry.startsWith('ghost-data-'))).toBe(true)
    // 活的不动
    expect(fs.existsSync(path.join(pluginsDir, 'node_modules', 'alive', 'plugin.json'))).toBe(true)
    expect(fs.existsSync(path.join(strayDir, 'plugin.json'))).toBe(true)
    expect(manager.getPlugins()
      .filter(info => info.definition.source !== 'builtin')
      .map(info => info.definition.id)).toEqual(['alive'])
  })

  it('账本不可信 = 整轮弃权:家目录孤儿不动,plugin-data 孤儿也不动', async () => {
    process.env.ONETHING_STORE_PATH = freshPluginsDir('store-a2')
    const pluginsDir = path.join(process.env.ONETHING_STORE_PATH, 'plugins')
    const dataRoot = path.join(process.env.ONETHING_STORE_PATH, 'plugin-data')
    fs.mkdirSync(pluginsDir, { recursive: true })
    // 坏账
    fs.writeFileSync(path.join(pluginsDir, 'package.json'), '{broken')
    makeNpmPlugin(pluginsDir, 'alive')
    // makeNpmPlugin 把账写好了 —— 重新弄坏它
    fs.writeFileSync(path.join(pluginsDir, 'package.json'), '{broken')
    fs.mkdirSync(path.join(pluginsDir, 'ghost-home'), { recursive: true })
    fs.mkdirSync(path.join(dataRoot, 'ghost-data'), { recursive: true })

    const { PluginManager } = await import('../manager.js')
    const manager = new PluginManager()
    await manager.refreshPlugins()

    // 什么都不能动(合并安全闸:scanTrusted && ledger.trusted)
    expect(fs.existsSync(path.join(pluginsDir, 'ghost-home'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'ghost-data'))).toBe(true)
    expect(fs.existsSync(path.join(pluginsDir, 'legacy-backup'))).toBe(false)
  })
})

// ── B 层:真 npm 的全生命周期(需要本机 npm,ONETHING_E2E_NPM=1 才跑)──

const E2E = process.env.ONETHING_E2E_NPM === '1'
const PLAN_STATUS_DIR = path.resolve(__dirname, '../../../../sample-plugins/plan-status')

describe.skipIf(!E2E)('B:真 npm 生命周期(生产适配器 runPluginNpm)', () => {
  it('脚手架自动创建;file: 装 plan-status;配置家文件跨重装存活;卸载拆账拆包、家目录归档', async () => {
    const pluginsDir = freshPluginsDir('store-b1-plugins')
    const {
      installPluginPackage,
      readInstalledPluginSpec,
      uninstallPluginPackage,
    } = await import('../install.js')
    const {
      scanCorePlugins,
      installCorePluginPackage: _unused, // 防误用:这层只走生产适配器
    } = await import('@onething/core/plugins')

    // 1. 装:脚手架 + file: 通道(pkg = 包内 package.json 的 name)
    const result = await installPluginPackage(pluginsDir, {
      pkg: 'onething-plugin-plan-status',
      spec: `file:${PLAN_STATUS_DIR}`,
    })
    expect(result).toEqual({ ok: true, pluginId: 'onething-plugin-plan-status' })
    const ledger = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'package.json'), 'utf-8'))
    expect(ledger.private).toBe(true)
    expect(ledger.name).toBe('onething-installed-plugins')
    const spec = readInstalledPluginSpec(pluginsDir, 'onething-plugin-plan-status')
    // npm 会把 file: spec 归一化成相对账本的路径 —— 断言指向对的地方,不逐字。
    expect(spec).toMatch(/^file:.*plan-status$/)

    // 2. 扫描得见(npm-ledger 语义;file: 目录形态 = symlink,扫描跟随)
    const scanned = scanCorePlugins({
      builtinPlugins: [],
      pluginsDir,
      getEnabled: () => true,
      scanMode: 'npm-ledger',
    })
    expect(scanned.map(def => def.id)).toEqual(['onething-plugin-plan-status'])

    // 3. 配置家文件 + 重装(update 的 file: 形态)= 配置原样保留
    const configPath = path.join(pluginsDir, 'onething-plugin-plan-status', 'config.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ milestone: 'p1' }))
    const reinstall = await installPluginPackage(pluginsDir, {
      pkg: 'onething-plugin-plan-status',
      spec: `file:${PLAN_STATUS_DIR}`,
    })
    expect(reinstall.ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ milestone: 'p1' })

    // 4. 卸载:账与包都拆;家目录由 manager 归档(这里只验 npm 侧)
    const removed = await uninstallPluginPackage(pluginsDir, 'onething-plugin-plan-status')
    expect(removed).toEqual({ removed: true })
    expect(fs.existsSync(path.join(pluginsDir, 'node_modules', 'onething-plugin-plan-status'))).toBe(false)
    expect(readInstalledPluginSpec(pluginsDir, 'onething-plugin-plan-status')).toBeUndefined()
    // 家目录是数据,不是 npm 的地盘 —— npm uninstall 不该碰它
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ milestone: 'p1' })
  }, 120_000)

  it('带 postinstall 的 tarball:装上后脚本未执行(--ignore-scripts 的实证)', async () => {
    const pluginsDir = freshPluginsDir('store-b2-plugins')
    const fixtureDir = path.join(storeRoot, 'trap-fixture')
    fs.mkdirSync(fixtureDir, { recursive: true })
    fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({
      name: 'trap-pkg',
      version: '1.0.0',
      scripts: {
        // 执行即落 marker;--ignore-scripts 生效则 marker 永不出现。
        postinstall: 'node -e "require(\'fs\').writeFileSync(\'postinstall-ran.txt\', \'yes\')"',
      },
    }))
    fs.writeFileSync(path.join(fixtureDir, 'plugin.json'), JSON.stringify({ name: 'trap-pkg' }))
    fs.writeFileSync(path.join(fixtureDir, 'plugin-entry.js'), 'export default function () {}\n')

    const { runPluginNpm, installPluginPackage } = await import('../install.js')
    const packed = await runPluginNpm(['pack'], fixtureDir)
    expect(packed.code).toBe(0)
    const tarball = path.join(fixtureDir, 'trap-pkg-1.0.0.tgz')
    expect(fs.existsSync(tarball)).toBe(true)

    const result = await installPluginPackage(pluginsDir, {
      pkg: 'trap-pkg',
      spec: `file:${tarball}`,
    })
    expect(result.ok).toBe(true)
    // 包装上了,但 postinstall 的 marker 不在 —— 脚本没跑过。
    expect(fs.existsSync(path.join(pluginsDir, 'node_modules', 'trap-pkg', 'plugin.json'))).toBe(true)
    expect(fs.existsSync(path.join(pluginsDir, 'node_modules', 'trap-pkg', 'postinstall-ran.txt'))).toBe(false)
  }, 120_000)
})
