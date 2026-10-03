import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fsSync from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureRuntimeLogs } from '../../logging/index.js'
import {
  canonicalizeSpaceDirectory,
  getSpaceOverlayConnectedDirectories,
  getSpaceOverlayDefaultSelection,
  getSpaceOverlayProviderEnabled,
  getSpaceOverlaySelectedModels,
  normalizeSpaceDefaultSelection,
  normalizeSpaceProviderEnabled,
  normalizeSpaceSelectedModels,
  mergeConnectedDirectories,
  normalizeSpaceDirectories,
  parseSpaceFile,
  readSpaceOverlay,
  resetSpaceOverlayCacheForTests,
  spaceFilePath,
  writeSpaceOverlay,
} from '../overlay.js'
import { setRootDirForTests } from '../persistence.js'
import { DEFAULT_SPACE_ID } from '../types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-spaces-overlay-'))
  setRootDirForTests(tmpDir)
  resetSpaceOverlayCacheForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceOverlayCacheForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('space overlay normalization', () => {
  it('is trailing-slash insensitive when deduping', () => {
    expect(canonicalizeSpaceDirectory('/a/b/')).toBe('/a/b')
    expect(canonicalizeSpaceDirectory('  /a/b//  ')).toBe('/a/b')
    expect(normalizeSpaceDirectories(['/a/b', '/a/b/', '/a/b//'])).toEqual(['/a/b'])
  })

  it('drops non-strings, blanks and relative paths, keeps first-seen order', () => {
    expect(
      normalizeSpaceDirectories(['/z', 42, '', '  ', 'relative/dir', '/a', '/z/']),
    ).toEqual(['/z', '/a'])
  })

  it('accepts windows drive roots, and only折叠尾斜杠(不归一分隔符,与 project-dirs 同口径)', () => {
    expect(normalizeSpaceDirectories(['C:\\work', 'C:\\work\\'])).toEqual(['C:\\work'])
    expect(normalizeSpaceDirectories(['C:\\work', 'C:/work'])).toEqual(['C:\\work', 'C:/work'])
  })

  it('merges global ∪ overlay with the global layer first', () => {
    expect(mergeConnectedDirectories(['/global'], ['/space', '/global/'])).toEqual([
      '/global',
      '/space',
    ])
    // overlay 缺席 = 只有全局层
    expect(mergeConnectedDirectories(['/global'], undefined)).toEqual(['/global'])
  })
})

describe('space.json parsing', () => {
  it('treats a missing overlay key as an empty overlay', () => {
    expect(parseSpaceFile({})).toEqual({ overlay: {} })
  })

  it('condemns the whole file when the structure is wrong', () => {
    expect(parseSpaceFile(null)).toBeNull()
    expect(parseSpaceFile([])).toBeNull()
    expect(parseSpaceFile('nope')).toBeNull()
    expect(parseSpaceFile({ overlay: 'nope' })).toBeNull()
    expect(parseSpaceFile({ overlay: { connectedDirectories: '/a' } })).toBeNull()
  })

  it('drops dirty entries inside a well-formed array without condemning the file', () => {
    expect(parseSpaceFile({ overlay: { connectedDirectories: ['/a', 7, '/a/'] } })).toEqual({
      overlay: { connectedDirectories: ['/a'] },
    })
  })
})

describe('space overlay persistence', () => {
  it('round-trips through workspaces/<id>/space.json', async () => {
    const written = writeSpaceOverlay('work', { connectedDirectories: ['/vault/', '/vault'] })
    expect(written).toEqual({ connectedDirectories: ['/vault/'] })

    const raw = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'work', 'space.json'), 'utf-8'),
    )
    // 落盘形状永远是 `{ overlay: {...} }` —— 给后续字段留位。
    expect(raw).toEqual({ overlay: { connectedDirectories: ['/vault/'] } })

    resetSpaceOverlayCacheForTests()
    expect(getSpaceOverlayConnectedDirectories('work')).toEqual(['/vault/'])
  })

  it('reads an absent file as an empty overlay', () => {
    expect(readSpaceOverlay('never-written')).toEqual({})
    expect(getSpaceOverlayConnectedDirectories('never-written')).toEqual([])
  })

  it('condemns a corrupt file to an empty overlay instead of throwing', async () => {
    const logs = captureRuntimeLogs()
    await fs.mkdir(path.join(tmpDir, 'broken'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'broken', 'space.json'), '{ not json', 'utf-8')
    expect(readSpaceOverlay('broken')).toEqual({})

    resetSpaceOverlayCacheForTests()
    await fs.writeFile(
      path.join(tmpDir, 'broken', 'space.json'),
      JSON.stringify({ overlay: { connectedDirectories: 'nope' } }),
      'utf-8',
    )
    expect(readSpaceOverlay('broken')).toEqual({})
    expect(logs.ofLevel('warn').length).toBeGreaterThan(0)
    logs.restore()
  })

  it('routes an illegal space id to the default space rather than out of the tree', () => {
    // id 是路径片段 —— `..` 必须落回 default,不能长出 workspaces/../…
    expect(spaceFilePath('../escape')).toBe(
      path.join(tmpDir, DEFAULT_SPACE_ID, 'space.json'),
    )
    expect(spaceFilePath(undefined as unknown as string)).toBe(
      path.join(tmpDir, DEFAULT_SPACE_ID, 'space.json'),
    )
  })

  it('invalidates its read cache on write', () => {
    writeSpaceOverlay('work', { connectedDirectories: ['/one'] })
    expect(getSpaceOverlayConnectedDirectories('work')).toEqual(['/one'])
    writeSpaceOverlay('work', { connectedDirectories: ['/two'] })
    expect(getSpaceOverlayConnectedDirectories('work')).toEqual(['/two'])
  })

  it('clears a field when the write omits it (整层写入,不是 patch)', () => {
    writeSpaceOverlay('work', { connectedDirectories: ['/one'] })
    expect(writeSpaceOverlay('work', {})).toEqual({})
    expect(getSpaceOverlayConnectedDirectories('work')).toEqual([])
  })
})

/* ── 批 B7 / B9 的三格:C2 之后**读得进、写不出** ────────────────────────── */

/**
 * `selectedModels` / `defaultSelection` / `providerEnabled` 已经并进
 * `workspaces/<id>/providers.json`(C2)。归一与解析**保留** —— 一次性迁移要从
 * 盘上的旧 overlay 里取值;写路**不再产出** —— 那正是迁移收尾的形状,不需要
 * 第二个开关来关掉它。
 */
function writeLegacyOverlay(spaceId: string, overlay: Record<string, unknown>): void {
  const dir = path.dirname(spaceFilePath(spaceId))
  fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(spaceFilePath(spaceId), JSON.stringify({ overlay }, null, 2), 'utf-8')
  resetSpaceOverlayCacheForTests()
}

describe('space overlay selectedModels(批 B7;C2 只读)', () => {
  it('丢非法形状,去重保序,**空数组保留**(空 ≠ 缺席)', () => {
    expect(normalizeSpaceSelectedModels({
      deepseek: ['a', 'b', 'a', '', 3, ' c '],
      zhipu: [],
      ' ': ['x'],
      broken: 'not-an-array',
    })).toEqual({ deepseek: ['a', 'b', 'c'], zhipu: [] })
  })

  it('整个值不是对象时交给调用方判废', () => {
    expect(normalizeSpaceSelectedModels(['a'])).toBeUndefined()
    expect(parseSpaceFile({ overlay: { selectedModels: ['a'] } })).toBeNull()
  })

  it('读侧兼容:盘上留着的旧数据仍读得出来(迁移要用它)', () => {
    writeLegacyOverlay('work', {
      connectedDirectories: ['/one'],
      selectedModels: { deepseek: ['deepseek-chat'], zhipu: [] },
    })
    expect(getSpaceOverlaySelectedModels('work')).toEqual({
      deepseek: ['deepseek-chat'],
      zhipu: [],
    })
  })
})

describe('space overlay defaultSelection(批 B9;C2 只读)', () => {
  it('归一:provider 必填、trim、model 可缺席', () => {
    expect(normalizeSpaceDefaultSelection({ provider: '  deepseek  ', model: ' deepseek-chat ' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(normalizeSpaceDefaultSelection({ provider: 'deepseek' })).toEqual({ provider: 'deepseek' })
    expect(normalizeSpaceDefaultSelection({ provider: 'deepseek', model: '   ' }))
      .toEqual({ provider: 'deepseek' })
  })

  it('归一:没有 provider 的「半句话」当缺席,不是空对象', () => {
    expect(normalizeSpaceDefaultSelection({ model: 'glm-5' })).toBeUndefined()
    expect(normalizeSpaceDefaultSelection({ provider: '   ' })).toBeUndefined()
    expect(normalizeSpaceDefaultSelection({ provider: 42 })).toBeUndefined()
    expect(normalizeSpaceDefaultSelection('deepseek')).toBeUndefined()
  })

  it('parse:脏对象只丢这一格(不判废整份),非对象才判废整份', () => {
    const dirty = parseSpaceFile({
      overlay: { connectedDirectories: ['/a'], defaultSelection: { model: 'glm-5' } },
    })
    expect(dirty).not.toBeNull()
    expect(dirty!.overlay.connectedDirectories).toEqual(['/a'])
    expect(dirty!.overlay.defaultSelection).toBeUndefined()

    expect(parseSpaceFile({ overlay: { defaultSelection: 'deepseek' } })).toBeNull()
  })

  it('读侧兼容:盘上留着的旧默认仍读得出来', () => {
    writeLegacyOverlay('work', { defaultSelection: { provider: 'zhipu', model: 'glm-5' } })
    expect(getSpaceOverlayDefaultSelection('work')).toEqual({ provider: 'zhipu', model: 'glm-5' })
  })
})

describe('space overlay providerEnabled(批 B9;C2 只读)', () => {
  it('归一:只收 boolean,键 trim,非布尔一律丢(不替用户表达)', () => {
    expect(normalizeSpaceProviderEnabled({
      ' deepseek ': false,
      zhipu: true,
      kimi: 'true',
      codex: 1,
      '': true,
    })).toEqual({ deepseek: false, zhipu: true })
    expect(normalizeSpaceProviderEnabled([])).toBeUndefined()
    expect(normalizeSpaceProviderEnabled(null)).toBeUndefined()
  })

  it('parse:结构不认就整份判废', () => {
    expect(parseSpaceFile({ overlay: { providerEnabled: ['deepseek'] } })).toBeNull()
  })

  it('读侧兼容:表达成 false 与缺席仍分得清', () => {
    writeLegacyOverlay('work', { providerEnabled: { deepseek: false } })
    expect(getSpaceOverlayProviderEnabled('work')).toEqual({ deepseek: false })
    expect(getSpaceOverlayProviderEnabled('work')?.zhipu).toBeUndefined()
  })
})

describe('C2:provider 三格已经不再写进 overlay', () => {
  it('写路把三格全部丢掉,接入目录照常落盘', async () => {
    const written = writeSpaceOverlay('work', {
      connectedDirectories: ['/one'],
      selectedModels: { deepseek: ['deepseek-chat'] },
      defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
      providerEnabled: { zhipu: false },
    })
    expect(written).toEqual({ connectedDirectories: ['/one'] })
    resetSpaceOverlayCacheForTests()
    const raw = JSON.parse(await fs.readFile(spaceFilePath('work'), 'utf-8'))
    expect(raw).toEqual({ overlay: { connectedDirectories: ['/one'] } })
  })

  it('第一次写回就把盘上的旧三格搬掉(迁移之后没有第二个来源)', () => {
    writeLegacyOverlay('work', {
      connectedDirectories: ['/one'],
      selectedModels: { deepseek: ['deepseek-chat'] },
    })
    writeSpaceOverlay('work', { connectedDirectories: ['/one', '/two'] })
    resetSpaceOverlayCacheForTests()
    expect(readSpaceOverlay('work')).toEqual({ connectedDirectories: ['/one', '/two'] })
  })

  it('default 空间没有特殊行为', () => {
    expect(getSpaceOverlayDefaultSelection(DEFAULT_SPACE_ID)).toBeUndefined()
    expect(getSpaceOverlayProviderEnabled(DEFAULT_SPACE_ID)).toBeUndefined()
  })
})
