/**
 * `file-pick` 的拷贝执行面(B 期,用户壁纸)。
 *
 * core 的判据已经被 `packages/core/plugins/__tests__/file-pick.test.ts` 钉住了,
 * 这里钉的是**接线**:闸真的挂在拷贝入口上、落点真的在这个插件的数据目录里、
 * 同名真的不覆盖、以及 `pluginStorageImageExists` 真的挡得住指向空气的图。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tmp = ''

vi.mock('../loader.js', () => ({
  getPluginsDir: () => tmp,
}))

const { getPluginImportsDir, importPluginFile, pluginStorageImageExists } = await import('../file-import.js')

let source = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-file-import-'))
  source = path.join(tmp, 'src')
  fs.mkdirSync(source, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeSource(name: string, bytes: number): string {
  const file = path.join(source, name)
  fs.writeFileSync(file, Buffer.alloc(bytes, 1))
  return file
}

describe('importPluginFile', () => {
  it('拷进 plugins/<id>/storage/imports/ 并只递回一个地址', () => {
    const outcome = importPluginFile({ pluginId: 'ink', sourcePath: writeSource('paper.png', 16) })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toEqual({ path: 'storage:imports/paper.png', name: 'paper.png', size: 16 })
    // 落点在数据区,不在代码区。
    expect(getPluginImportsDir('ink')).toBe(path.join(tmp, 'ink', 'storage', 'imports'))
    expect(fs.existsSync(path.join(tmp, 'ink', 'storage', 'imports', 'paper.png'))).toBe(true)
    // **递回去的东西里没有用户的路径** —— 这是这一期的核心裁决。
    expect(JSON.stringify(outcome.result)).not.toContain(source)
  })

  it('清洗文件名 —— 用户磁盘上的原名不原样落盘', () => {
    const outcome = importPluginFile({ pluginId: 'ink', sourcePath: writeSource('My Paper (1).PNG', 8) })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.name).toBe('MyPaper1.png')
  })

  it('同名不覆盖', () => {
    importPluginFile({ pluginId: 'ink', sourcePath: writeSource('paper.png', 8) })
    const second = importPluginFile({ pluginId: 'ink', sourcePath: writeSource('paper.png', 8) })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.result.name).toBe('paper-2.png')
    expect(fs.readdirSync(path.join(tmp, 'ink', 'storage', 'imports')).sort())
      .toEqual(['paper-2.png', 'paper.png'])
  })

  it('扩展名闸:accept 之外的一律拒,并且不留下任何目录', () => {
    const outcome = importPluginFile({
      pluginId: 'ink',
      sourcePath: writeSource('a.gif', 8),
      accept: ['png', 'webp'],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toMatch(/isn't supported here/)
    // 被拒的导入不该留下一个空的 imports/ —— 足迹里凭空多一个目录说不清来历。
    expect(fs.existsSync(path.join(tmp, 'ink'))).toBe(false)
  })

  it('尺寸闸:超过声明上限的拒', () => {
    const outcome = importPluginFile({
      pluginId: 'ink',
      sourcePath: writeSource('big.png', 4096),
      maxBytes: 1024,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toMatch(/too large/)
  })

  it('声明的上限比宿主硬顶大时按硬顶算(钳制,不是拒绝)', () => {
    const outcome = importPluginFile({
      pluginId: 'ink',
      sourcePath: writeSource('ok.png', 16),
      maxBytes: Number.MAX_SAFE_INTEGER,
    })
    expect(outcome.ok).toBe(true)
  })

  it('目录 / 不存在的路径:说人话,不抛', () => {
    expect(importPluginFile({ pluginId: 'ink', sourcePath: source }))
      .toEqual({ ok: false, reason: 'Pick a file, not a folder.' })
    expect(importPluginFile({ pluginId: 'ink', sourcePath: path.join(source, 'nope.png') }))
      .toEqual({ ok: false, reason: 'That file could not be read.' })
  })
})

describe('pluginStorageImageExists', () => {
  it('导入过的图存在,没导入过的不存在', () => {
    importPluginFile({ pluginId: 'ink', sourcePath: writeSource('paper.png', 8) })
    expect(pluginStorageImageExists('ink', 'storage:imports/paper.png')).toBe(true)
    expect(pluginStorageImageExists('ink', 'storage:imports/ghost.png')).toBe(false)
    // 另一个插件的 storage 是另一个根 —— 同一个地址在那里不存在。
    expect(pluginStorageImageExists('other', 'storage:imports/paper.png')).toBe(false)
  })

  it('穿越 / 绝对 / 非 storage: 前缀一律 false', () => {
    fs.mkdirSync(path.join(tmp, 'ink'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'ink', 'kv.json'), '{}')
    for (const bad of [
      'storage:../kv.json',
      'storage:/etc/passwd.png',
      'bg/paper.png',
      '',
    ]) {
      expect(pluginStorageImageExists('ink', bad), bad).toBe(false)
    }
  })
})
