import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalizeSpaceDirectory,
  getSpaceOverlayConnectedDirectories,
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    expect(warn).toHaveBeenCalled()
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
