/**
 * P1-4 验收:配置搬家与拆除闩。
 *
 * 拍板(设计 §7):
 *  - 自有配置从 plugin-settings 的 config.<id> 搬进 `plugins/<id>/config.json`,
 *    首次读写惰性迁移,中央行抹掉(有实际搬移才重写中央文件);
 *  - 判别只剩一条(2026-08-09 legacy 清零):所有插件的配置都住家目录,
 *    plugins/<id>/ 里有没有 plugin.json 都一样;
 *  - §7.4:config / KV / storage 三条写路径统一挂拆除闩 —— 卸载完成后到的
 *    任何写 = warn + 静默丢弃,不重建刚归档的家目录;
 *  - plugins/ 家目录孤儿收尸:无主的纯数据目录归档进 plugins/legacy-backup/。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createCorePluginStorage,
  findCorePluginHomeOrphans,
  getCorePluginSettingsPath,
  writePluginSettingsFile,
} from '@onething/core/plugins'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-config-home-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const pluginsDir = path.join(storeRoot, 'plugins')
const settingsPath = getCorePluginSettingsPath({ storePath: storeRoot })

function seedCentralConfig(pluginId: string, config: Record<string, unknown>): void {
  writePluginSettingsFile(settingsPath, { config: { [pluginId]: config } })
}

function readCentralConfigRow(pluginId: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(settingsPath)) return undefined
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
    config?: Record<string, Record<string, unknown>>
  }
  return settings.config?.[pluginId]
}

async function loader() {
  return import('../loader.js')
}

describe('配置搬家(plugin-settings → plugins/<id>/config.json)', () => {
  it('首读惰性迁移:写新文件 + 抹中央行,值原样可读', async () => {
    const { readPluginConfig } = await loader()
    seedCentralConfig('migrant', { theme: 'dark', retries: 3 })
    const before = fs.readFileSync(settingsPath, 'utf-8')
    expect(readCentralConfigRow('migrant')).toEqual({ theme: 'dark', retries: 3 })

    expect(readPluginConfig('migrant')).toEqual({ theme: 'dark', retries: 3 })

    const homeFile = path.join(pluginsDir, 'migrant', 'config.json')
    expect(JSON.parse(fs.readFileSync(homeFile, 'utf-8'))).toEqual({ theme: 'dark', retries: 3 })
    expect(readCentralConfigRow('migrant')).toBeUndefined()
    // 中央文件被重写过(行没了)
    expect(fs.readFileSync(settingsPath, 'utf-8')).not.toBe(before)
    // 再读走新文件,不再碰中央
    expect(readPluginConfig('migrant')).toEqual({ theme: 'dark', retries: 3 })
  })

  it('writePluginConfig 写家文件并顺手抹中央残留行;null 删文件', async () => {
    const { writePluginConfig, readPluginConfig } = await loader()
    seedCentralConfig('writer', { old: true })

    writePluginConfig('writer', { fresh: 1 })
    expect(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'writer', 'config.json'), 'utf-8'))).toEqual({ fresh: 1 })
    expect(readCentralConfigRow('writer')).toBeUndefined()

    writePluginConfig('writer', null)
    expect(fs.existsSync(path.join(pluginsDir, 'writer', 'config.json'))).toBe(false)
    expect(readPluginConfig('writer')).toEqual({})
  })

  it('目录里有 plugin.json 也不再分叉:配置照样住家目录', async () => {
    const { writePluginConfig, readPluginConfig } = await loader()
    const strayDir = path.join(pluginsDir, 'stray-one')
    fs.mkdirSync(strayDir, { recursive: true })
    fs.writeFileSync(path.join(strayDir, 'plugin.json'), JSON.stringify({ name: 'stray-one' }))

    writePluginConfig('stray-one', { keep: 'home' })

    expect(JSON.parse(fs.readFileSync(path.join(strayDir, 'config.json'), 'utf-8'))).toEqual({ keep: 'home' })
    expect(readCentralConfigRow('stray-one')).toBeUndefined()
    expect(readPluginConfig('stray-one')).toEqual({ keep: 'home' })
    fs.rmSync(strayDir, { recursive: true, force: true })
  })

  it('内置插件形态(plugins/<id> 根本不存在)= 同规则住家目录', async () => {
    const { writePluginConfig, readPluginConfig } = await loader()
    writePluginConfig('builtin-style', { level: 2 })
    expect(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'builtin-style', 'config.json'), 'utf-8')))
      .toEqual({ level: 2 })
    expect(readPluginConfig('builtin-style')).toEqual({ level: 2 })
  })
})

describe('§7.4 拆除闩', () => {
  it('markPluginDemolished 后:配置写被丢弃,家目录不复活', async () => {
    const { writePluginConfig, markPluginDemolished, isPluginDemolished } = await loader()
    const homeDir = path.join(pluginsDir, 'goner')
    // 归档后的状态:家目录不在
    expect(fs.existsSync(homeDir)).toBe(false)

    markPluginDemolished('goner')
    expect(isPluginDemolished('goner')).toBe(true)
    writePluginConfig('goner', { ghost: true })

    expect(fs.existsSync(homeDir)).toBe(false)
    expect(readCentralConfigRow('goner')).toBeUndefined()
  })

  it('拆除闩挡惰性迁移:已拆插件的中央行不搬家(留给归档/回退处理)', async () => {
    const { readPluginConfig, markPluginDemolished } = await loader()
    seedCentralConfig('demolished-migrant', { x: 1 })
    markPluginDemolished('demolished-migrant')

    expect(readPluginConfig('demolished-migrant')).toEqual({ x: 1 })
    expect(fs.existsSync(path.join(pluginsDir, 'demolished-migrant', 'config.json'))).toBe(false)
    expect(readCentralConfigRow('demolished-migrant')).toEqual({ x: 1 })
  })

  it('扫描里再现 = 已重装,闩自动解除', async () => {
    const { markPluginDemolished, isPluginDemolished, scanPlugins } = await loader()
    markPluginDemolished('reinstalled')
    // 以 npm 形态重装:账 + 包(账是 plugins/package.json,不是 plugin-settings)
    fs.writeFileSync(path.join(pluginsDir, 'package.json'), JSON.stringify({
      private: true, name: 'onething-installed-plugins',
      dependencies: { reinstalled: 'https://example/reinstalled-1.0.0.tgz' },
    }))
    const pkgDir = path.join(pluginsDir, 'node_modules', 'reinstalled')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'reinstalled', version: '1.0.0' }))
    fs.writeFileSync(path.join(pkgDir, 'plugin.json'), JSON.stringify({ name: 'reinstalled' }))
    fs.writeFileSync(path.join(pkgDir, 'plugin-entry.js'), 'export default function () {}\n')

    const found = scanPlugins()
    expect(found.some(def => def.id === 'reinstalled')).toBe(true)
    expect(isPluginDemolished('reinstalled')).toBe(false)
    fs.rmSync(path.join(pluginsDir, 'node_modules'), { recursive: true, force: true })
    fs.rmSync(path.join(pluginsDir, 'package.json'), { force: true })
  })

  it('storage 写路径:闩下后 writeJson 丢弃且目录不复活', () => {
    let disposed = false
    const storage = createCorePluginStorage({
      pluginId: 'latched',
      dataRoot: path.join(storeRoot, 'plugin-data'),
      homeRoot: pluginsDir,
      isDisposed: () => disposed,
    })
    storage.writeJson('before.json', { ok: 1 })
    expect(fs.existsSync(path.join(pluginsDir, 'latched', 'storage', 'before.json'))).toBe(true)

    disposed = true
    fs.rmSync(path.join(pluginsDir, 'latched'), { recursive: true, force: true })
    storage.writeJson('after.json', { ghost: true })
    expect(fs.existsSync(path.join(pluginsDir, 'latched'))).toBe(false)
  })
})

describe('足迹枚举(宪法第 6 条)—— 与归档同一把尺', () => {
  it('足迹一律枚举家目录 —— plugin-data 不再是任何插件的数据根', async () => {
    const { getPluginFootprint } = await loader()
    // npm 形态:家目录(config/kv/storage 三层)
    const home = path.join(pluginsDir, 'npm-form')
    fs.mkdirSync(path.join(home, 'storage'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config.json'), '{}')
    fs.writeFileSync(path.join(home, 'kv.json'), '{}')
    fs.writeFileSync(path.join(home, 'storage', 'notes.json'), '[]')
    const fp = getPluginFootprint('npm-form')
    expect(fp.dataDir).toBe(home)
    expect(fp.dataDirExists).toBe(true)
    expect(fp.entries).toEqual(expect.arrayContaining(['config.json', 'kv.json', 'storage']))

    // 手工代码目录(有 plugin.json)同样按家目录枚举:旧根不再参与判别。
    const strayDir = path.join(pluginsDir, 'stray-fp')
    fs.mkdirSync(strayDir, { recursive: true })
    fs.writeFileSync(path.join(strayDir, 'plugin.json'), '{}')
    fs.mkdirSync(path.join(storeRoot, 'plugin-data', 'stray-fp'), { recursive: true })
    fs.writeFileSync(path.join(storeRoot, 'plugin-data', 'stray-fp', 'kv.json'), '{}')
    const strayFp = getPluginFootprint('stray-fp')
    expect(strayFp.dataDir).toBe(strayDir)
    expect(strayFp.entries).toEqual(['plugin.json'])
    fs.rmSync(strayDir, { recursive: true, force: true })
  })
})

describe('findCorePluginHomeOrphans —— 家目录孤儿收尸', () => {
  it('无主的纯数据目录是孤儿;账外代码目录/存活 id/legacy-backup 都不是', () => {
    const plugins = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-home-orphan-'))
    // 孤儿家目录(只有数据)
    fs.mkdirSync(path.join(plugins, 'ghost', 'storage'), { recursive: true })
    // 存活的家目录
    fs.mkdirSync(path.join(plugins, 'alive'), { recursive: true })
    // 账外的手工代码目录(有 plugin.json):宿主不加载它,也不把它当数据 ——
    // 既不是插件也不是"家目录孤儿",原地不动。
    const strayDir = path.join(plugins, 'stray-code')
    fs.mkdirSync(strayDir, { recursive: true })
    fs.writeFileSync(path.join(strayDir, 'plugin.json'), '{}')
    // legacy-backup 自身永远不是候选
    fs.mkdirSync(path.join(plugins, 'legacy-backup', 'older-2026'), { recursive: true })
    // node_modules 不是候选
    fs.mkdirSync(path.join(plugins, 'node_modules', 'pkg'), { recursive: true })

    const orphans = findCorePluginHomeOrphans(plugins, ['alive'])

    expect(orphans).toEqual([{ pluginId: 'ghost', kind: 'directory' }])
    fs.rmSync(plugins, { recursive: true, force: true })
  })
})
