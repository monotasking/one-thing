/**
 * 消息作用域状态存储(plugin-message-state-2026-08)。
 *
 * 北极星:
 *  - 两级布局 `message-state/<sid>/<mid>.json`,目录遍历即索引;
 *  - lifetime 闸门:persistent 落盘+创建时水合,ephemeral 纯内存;
 *  - 级联入口(handleMessageDeleted/handleSessionDeleted)清缓存+磁盘;
 *  - 配额宿主硬顶(写超 → 'quota' 写面抛);拆除闩与 KV 同一条;
 *  - 损坏记录在水合时隔离并跳过 —— 插件加载不死在一条坏记录上。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_MESSAGE_STATE_DIR_NAME,
  PluginStorageError,
  createCorePluginMessageStateStore,
  getCorePluginMessageStateDir,
} from '@onething/core/plugins'

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-msg-state-'))
}

function stateDir(root: string, pluginId = 'tps-meter'): string {
  return getCorePluginMessageStateDir(root, pluginId)
}

function writeRecord(root: string, sid: string, mid: string, value: unknown): void {
  const file = path.join(stateDir(root), sid, `${mid}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

describe('消息态:布局与读写', () => {
  it('persistent:写落盘到 message-state/<sid>/<mid>.json,读回一致', () => {
    const root = tempRoot()
    const store = createCorePluginMessageStateStore({ pluginId: 'tps-meter', homeRoot: root, persistent: true })
    store.writeJson('s1', 'm1', { tps: 34.2, outputTokens: 39 })
    expect(store.readJson('s1', 'm1')).toEqual({ tps: 34.2, outputTokens: 39 })
    expect(store.exists('s1', 'm1')).toBe(true)
    const file = path.join(stateDir(root), 's1', 'm1.json')
    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ tps: 34.2, outputTokens: 39 })
    // 家目录分层:message-state 与 kv/storage 平级
    expect(path.basename(stateDir(root))).toBe(PLUGIN_MESSAGE_STATE_DIR_NAME)
  })

  it('persistent:重启(新实例)后水合,老记录还在', () => {
    const root = tempRoot()
    writeRecord(root, 's1', 'm-old', { tps: 14.5 })
    const store = createCorePluginMessageStateStore({ pluginId: 'tps-meter', homeRoot: root, persistent: true })
    expect(store.readJson('s1', 'm-old')).toEqual({ tps: 14.5 })
    expect(store.exists('s1', 'm-old')).toBe(true)
  })

  it('ephemeral:纯内存 —— 写不落盘,新实例水合不到', () => {
    const root = tempRoot()
    const store = createCorePluginMessageStateStore({ pluginId: 'x', homeRoot: root, persistent: false })
    store.writeJson('s1', 'm1', { v: 1 })
    expect(store.readJson('s1', 'm1')).toEqual({ v: 1 })
    expect(fs.existsSync(stateDir(root, 'x'))).toBe(false)
    const fresh = createCorePluginMessageStateStore({ pluginId: 'x', homeRoot: root, persistent: false })
    expect(fresh.exists('s1', 'm1')).toBe(false)
  })

  it('读不存在 → fallback;不可序列化 → not-serializable 写面抛', () => {
    const root = tempRoot()
    const store = createCorePluginMessageStateStore({ pluginId: 'x', homeRoot: root, persistent: true })
    expect(store.readJson('s1', 'nope', { d: 1 })).toEqual({ d: 1 })
    expect(() => store.writeJson('s1', 'm1', { fn: () => 1 })).toThrow(PluginStorageError)
    expect(() => store.writeJson('s1', 'm1', { fn: () => 1 })).toThrow(/not-serializable|JSON-serializable/)
  })
})

describe('消息态:级联', () => {
  it('handleMessageDeleted:清该条(缓存+磁盘),同会话其他条不受影响', () => {
    const root = tempRoot()
    const store = createCorePluginMessageStateStore({ pluginId: 'x', homeRoot: root, persistent: true })
    store.writeJson('s1', 'm1', { v: 1 })
    store.writeJson('s1', 'm2', { v: 2 })
    store.handleMessageDeleted('s1', 'm1')
    expect(store.exists('s1', 'm1')).toBe(false)
    expect(store.exists('s1', 'm2')).toBe(true)
    expect(fs.existsSync(path.join(stateDir(root, 'x'), 's1', 'm1.json'))).toBe(false)
    expect(fs.existsSync(path.join(stateDir(root, 'x'), 's1', 'm2.json'))).toBe(true)
  })

  it('handleSessionDeleted:清整个会话目录,其他会话不受影响', () => {
    const root = tempRoot()
    const store = createCorePluginMessageStateStore({ pluginId: 'x', homeRoot: root, persistent: true })
    store.writeJson('s1', 'm1', { v: 1 })
    store.writeJson('s2', 'm9', { v: 9 })
    store.handleSessionDeleted('s1')
    expect(store.exists('s1', 'm1')).toBe(false)
    expect(store.exists('s2', 'm9')).toBe(true)
    expect(fs.existsSync(path.join(stateDir(root, 'x'), 's1'))).toBe(false)
    expect(fs.existsSync(path.join(stateDir(root, 'x'), 's2', 'm9.json'))).toBe(true)
  })

  it('ephemeral 也级联:内存条目同样被清', () => {
    const root = tempRoot()
    const store = createCorePluginMessageStateStore({ pluginId: 'x', homeRoot: root, persistent: false })
    store.writeJson('s1', 'm1', { v: 1 })
    store.handleMessageDeleted('s1', 'm1')
    expect(store.exists('s1', 'm1')).toBe(false)
  })
})

describe('消息态:配额与损坏', () => {
  it('配额硬顶:写超 → quota 写面抛;既有条目不丢', () => {
    const root = tempRoot()
    const store = createCorePluginMessageStateStore({
      pluginId: 'x', homeRoot: root, persistent: true, quotaBytes: 128,
    })
    store.writeJson('s1', 'm1', { v: 'a'.repeat(60) })
    expect(() => store.writeJson('s1', 'm2', { v: 'b'.repeat(200) })).toThrow(/quota/)
    expect(store.exists('s1', 'm2')).toBe(false)
    expect(store.readJson('s1', 'm1')).toEqual({ v: 'a'.repeat(60) })
    // 覆写既有条目按差值计费
    store.writeJson('s1', 'm1', { v: 'a'.repeat(10) })
    expect(store.totalBytes()).toBeLessThan(128)
  })

  it('水合遇损坏记录:挪 .corrupt-* 隔离并跳过,加载不炸,其余记录正常', () => {
    const root = tempRoot()
    writeRecord(root, 's1', 'good', { tps: 1 })
    const bad = path.join(stateDir(root), 's1', 'bad.json')
    fs.mkdirSync(path.dirname(bad), { recursive: true })
    fs.writeFileSync(bad, '{not json')
    const store = createCorePluginMessageStateStore({ pluginId: 'tps-meter', homeRoot: root, persistent: true })
    expect(store.exists('s1', 'good')).toBe(true)
    expect(store.exists('s1', 'bad')).toBe(false)
    const siblings = fs.readdirSync(path.join(stateDir(root), 's1'))
    expect(siblings.some(f => f.startsWith('bad.json.corrupt-'))).toBe(true)
  })
})

describe('消息态:拆除闩(§7.4)', () => {
  it('dispose 后写静默丢弃(不建鬼目录),读仍可用', () => {
    const root = tempRoot()
    let disposed = false
    const store = createCorePluginMessageStateStore({
      pluginId: 'x', homeRoot: root, persistent: true, isDisposed: () => disposed,
    })
    store.writeJson('s1', 'm1', { v: 1 })
    disposed = true
    store.writeJson('s1', 'm2', { v: 2 })
    expect(fs.existsSync(path.join(stateDir(root, 'x'), 's1', 'm2.json'))).toBe(false)
    expect(store.readJson('s1', 'm1')).toEqual({ v: 1 })
  })
})
