/**
 * 轻通道(本地单文件插件形态)—— core 层扫描验收
 * (docs/design/pi-benchmark-adoption-2026-08.md §2 轻通道)。
 *
 * 打的是"合成 definition 的形状与扫描语义":id = 文件名去扩展名、无 manifest
 * (无 contributes,能力面据此收窄)、source='local'、专用目录、坏目录/缺目录容错、
 * 与 `plugins/` 的 npm 账本扫描物理分离(A 期不回退)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getCoreLocalPluginsDir,
  scanLocalPluginFiles,
} from '@onething/backend/plugin/plugin-contract'

function tempStore(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onething-local-plugin-'))
}

function writeScript(dir: string, filename: string, body = 'export default function () {}\n'): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), body)
}

describe('getCoreLocalPluginsDir', () => {
  it('专用目录是 <store>/plugins-dev,与 plugins/ 分离', () => {
    const store = tempStore()
    expect(getCoreLocalPluginsDir({ storePath: store })).toBe(path.join(store, 'plugins-dev'))
    expect(getCoreLocalPluginsDir({ storePath: store })).not.toBe(path.join(store, 'plugins'))
  })
})

describe('scanLocalPluginFiles', () => {
  it('单文件 → 合成 definition:id=文件名去扩展名、source=local、无 contributes', () => {
    const dir = path.join(tempStore(), 'plugins-dev')
    writeScript(dir, 'hello-gauge.ts')

    const scanned = scanLocalPluginFiles({ localPluginsDir: dir, getEnabled: () => true })

    expect(scanned).toHaveLength(1)
    const def = scanned[0]
    expect(def.id).toBe('hello-gauge')
    expect(def.source).toBe('local')
    expect(def.manifest.name).toBe('hello-gauge')
    expect(def.manifest.contributes).toBeUndefined()
    expect(def.dirPath).toBe(dir)
    expect(def.entryPath).toBe(path.join(dir, 'hello-gauge.ts'))
    expect(def.enabled).toBe(true)
    expect(def.entry).toBeUndefined()
  })

  it('接受 .ts/.js/.mjs/.cjs/.mts/.cts;拒绝 .d.ts、无扩展名与非脚本文件', () => {
    const dir = path.join(tempStore(), 'plugins-dev')
    writeScript(dir, 'a.ts')
    writeScript(dir, 'b.js')
    writeScript(dir, 'c.mjs')
    writeScript(dir, 'd.cjs')
    writeScript(dir, 'types.d.ts', 'export type X = number\n')
    writeScript(dir, 'README.md', '# not a plugin\n')
    writeScript(dir, 'noext', 'whatever\n')

    const ids = scanLocalPluginFiles({ localPluginsDir: dir, getEnabled: () => true })
      .map(def => def.id)
      .sort()

    expect(ids).toEqual(['a', 'b', 'c', 'd'])
  })

  it('点开头的文件跳过(编辑器临时文件/隐藏文件)', () => {
    const dir = path.join(tempStore(), 'plugins-dev')
    writeScript(dir, '.hidden.ts')
    writeScript(dir, 'visible.ts')

    const ids = scanLocalPluginFiles({ localPluginsDir: dir, getEnabled: () => true }).map(d => d.id)
    expect(ids).toEqual(['visible'])
  })

  it('enabled 位由 getEnabled 决定(与内置/npm 同一本账)', () => {
    const dir = path.join(tempStore(), 'plugins-dev')
    writeScript(dir, 'on.ts')
    writeScript(dir, 'off.ts')

    const byId = new Map(
      scanLocalPluginFiles({
        localPluginsDir: dir,
        getEnabled: id => id !== 'off',
      }).map(def => [def.id, def.enabled]),
    )
    expect(byId.get('on')).toBe(true)
    expect(byId.get('off')).toBe(false)
  })

  it('seenIds 让位于已占用的 id(内置/npm 同名者赢),同 id 的两个本地文件后者也退让', () => {
    const dir = path.join(tempStore(), 'plugins-dev')
    writeScript(dir, 'already-taken.ts') // 与一个已占用 id 撞名
    writeScript(dir, 'unique.ts')

    const seen = new Set<string>(['already-taken'])
    const ids = scanLocalPluginFiles({ localPluginsDir: dir, seenIds: seen, getEnabled: () => true })
      .map(def => def.id)

    expect(ids).toEqual(['unique'])
  })

  it('目录不存在 = 可信的空(还没建过 plugins-dev),不抛', () => {
    const dir = path.join(tempStore(), 'plugins-dev-missing')
    expect(scanLocalPluginFiles({ localPluginsDir: dir, getEnabled: () => true })).toEqual([])
  })

  it('只读自己的目录 —— plugins/ 里的 npm 结构一概不碰', () => {
    const store = tempStore()
    // 造一个 plugins/ 账本 + node_modules 插件,plugins-dev/ 里放一个本地脚本。
    const plugins = path.join(store, 'plugins')
    fs.mkdirSync(path.join(plugins, 'node_modules', 'npm-demo'), { recursive: true })
    fs.writeFileSync(path.join(plugins, 'package.json'), JSON.stringify({ dependencies: { 'npm-demo': 'file:x' } }))
    fs.writeFileSync(path.join(plugins, 'node_modules', 'npm-demo', 'plugin.json'), '{"name":"npm-demo"}')
    const dev = path.join(store, 'plugins-dev')
    writeScript(dev, 'gauge.ts')

    const scanned = scanLocalPluginFiles({ localPluginsDir: dev, getEnabled: () => true })
    expect(scanned.map(d => d.id)).toEqual(['gauge'])
    // plugins/ 原物未动
    expect(fs.existsSync(path.join(plugins, 'node_modules', 'npm-demo', 'plugin.json'))).toBe(true)
  })
})
