/**
 * P1 验收:家目录布局 —— 插件的全部**数据**足迹住进 `plugins/<id>/`,
 * 与代码区 `plugins/node_modules/` 并列;旧数据根(plugin-data)的足迹
 * 首次访问时惰性搬入。
 *
 * 北极星:
 *  - node_modules 是一次性代码区,数据写进去必须当场抛(铁律执行点);
 *  - 家目录内部分层:config/kv 宿主管,storage/ 插件管;
 *  - 迁移惰性且保守:目标已存在就保留目标,旧物留给归档,绝不静默覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CorePluginStore,
  PLUGIN_CONFIG_FILE_NAME,
  PLUGIN_SCRATCH_DIR_NAME,
  PluginStorageError,
  assertNotInNodeModules,
  assertSafePluginDirName,
  createCorePluginStorage,
  getCorePluginConfigPath,
  getCorePluginHomeDir,
  getCorePluginScratchDir,
} from '@onething/core/plugins'

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-home-'))
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

describe('家目录路径与铁律', () => {
  it('路径形状:home/config/scratch 分层', () => {
    const plugins = tempRoot()
    expect(getCorePluginHomeDir(plugins, 'plan-status')).toBe(path.join(plugins, 'plan-status'))
    expect(getCorePluginConfigPath(plugins, 'plan-status'))
      .toBe(path.join(plugins, 'plan-status', PLUGIN_CONFIG_FILE_NAME))
    expect(getCorePluginScratchDir(plugins, 'plan-status'))
      .toBe(path.join(plugins, 'plan-status', PLUGIN_SCRATCH_DIR_NAME))
  })

  it('node_modules 下任何写 = 当场抛(文件/目录/深层嵌套)', () => {
    const plugins = tempRoot()
    const nm = path.join(plugins, 'node_modules')
    expect(() => assertNotInNodeModules(plugins, path.join(nm, 'pkg', 'kv.json'))).toThrow(PluginStorageError)
    expect(() => assertNotInNodeModules(plugins, nm)).toThrow(PluginStorageError)
    expect(() => assertNotInNodeModules(plugins, path.join(nm, '@scope', 'pkg', 'deep', 'x.json'))).toThrow(PluginStorageError)
    // 家目录与 plugin-data 都合法
    expect(() => assertNotInNodeModules(plugins, path.join(plugins, 'plan-status', 'kv.json'))).not.toThrow()
    expect(() => assertNotInNodeModules(plugins, path.join(plugins, 'plan-status', 'storage', 'f.json'))).not.toThrow()
  })

  it('"node_modules" 不能当插件 id(否则家目录就是代码区)', () => {
    expect(() => assertSafePluginDirName('node_modules')).toThrow(PluginStorageError)
  })
})

describe('createCorePluginStorage(homeRoot) —— api.storage 的新家', () => {
  it('scratch 落进 plugins/<id>/storage/;旧数据根不再被读', () => {
    const root = tempRoot()
    const legacyData = path.join(root, 'plugin-data')
    const plugins = path.join(root, 'plugins')
    // 旧根里的东西自 2026-08-09 起没有读路径 —— 它只等孤儿收尸。
    writeJson(path.join(legacyData, 'demo', 'old-file.json'), { from: 'legacy' })

    const storage = createCorePluginStorage({ pluginId: 'demo', dataRoot: legacyData, homeRoot: plugins })
    expect(storage.readJson('old-file.json')).toBeUndefined()
    expect(fs.existsSync(path.join(legacyData, 'demo', 'old-file.json'))).toBe(true)

    storage.writeJson('new-file.json', { fresh: 1 })
    expect(fs.existsSync(path.join(plugins, 'demo', 'storage', 'new-file.json'))).toBe(true)
    expect(storage.dir()).toBe(path.join(plugins, 'demo', 'storage'))
  })

  it('不给 homeRoot = 旧布局,行为与 R4 一致', () => {
    const root = tempRoot()
    const storage = createCorePluginStorage({ pluginId: 'demo', dataRoot: root })
    storage.writeJson('x.json', [1])
    expect(fs.existsSync(path.join(root, 'demo', 'x.json'))).toBe(true)
    expect(storage.dir()).toBe(path.join(root, 'demo'))
  })
})

describe('CorePluginStore(homeRoot) —— KV 的新家', () => {
  it('kv 只认家目录;旧根里的 kv 不再被搬也不再被读', () => {
    const root = tempRoot()
    const legacyData = path.join(root, 'plugin-data')
    const plugins = path.join(root, 'plugins')
    writeJson(path.join(legacyData, 'demo', 'kv.json'), { token: 'abc' })

    const store = new CorePluginStore('demo', { dataDir: legacyData, homeRoot: plugins })
    expect(store.get('token')).toBeUndefined()
    store.set('next', 2)
    expect(JSON.parse(fs.readFileSync(path.join(plugins, 'demo', 'kv.json'), 'utf8'))).toEqual({ next: 2 })
    // 旧根原地不动 —— 归档是孤儿扫描的事,不是读路径的事。
    expect(fs.existsSync(path.join(legacyData, 'demo', 'kv.json'))).toBe(true)
  })
})
