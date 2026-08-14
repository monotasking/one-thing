import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSpacesStoreForTests } from '../store.js'
import { setRootDirForTests } from '../persistence.js'
import {
  getProjectsStore,
  resetProjectsStoreForTests,
} from '../../project-dirs/store.js'
import { DEFAULT_SPACE_ID, resolveSpaceId, sortSpaces } from '../types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-spaces-store-'))
  setRootDirForTests(tmpDir)
  resetProjectsStoreForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  resetProjectsStoreForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('Onething spaces store', () => {
  it('mints the default space on first initialize and persists it', async () => {
    const store = resetSpacesStoreForTests()
    expect(store.list()).toEqual([
      expect.objectContaining({ id: DEFAULT_SPACE_ID, name: '默认空间' }),
    ])

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'index.json'), 'utf-8'))
    expect(raw.spaces).toHaveLength(1)
    expect(raw.spaces[0].id).toBe(DEFAULT_SPACE_ID)
  })

  it('creates, renames and persists spaces across a reload', async () => {
    const store = resetSpacesStoreForTests()
    const work = store.create({ name: '工作' })
    expect(work.id).not.toBe(DEFAULT_SPACE_ID)
    // 每个 space 一个目录(B1 只占位,后续切片往里放 credentials.json)。
    await expect(fs.stat(path.join(tmpDir, work.id))).resolves.toBeTruthy()

    expect(store.update(work.id, { name: '工作台', color: '#ff0000' })).toMatchObject({
      name: '工作台',
      color: '#ff0000',
    })
    expect(store.update('nope', { name: 'x' })).toBeNull()

    const reloaded = resetSpacesStoreForTests()
    expect(reloaded.list().map(space => space.id)).toEqual([DEFAULT_SPACE_ID, work.id])
    expect(reloaded.get(work.id)).toMatchObject({ name: '工作台', color: '#ff0000' })
  })

  it('rejects an empty name and a duplicate id', () => {
    const store = resetSpacesStoreForTests()
    expect(() => store.create({ name: '   ' })).toThrow(/non-empty/)
    store.create({ id: 'alpha', name: 'Alpha' })
    expect(() => store.create({ id: 'alpha', name: 'Again' })).toThrow(/already exists/)
    // id 会成为路径片段 —— 非法字符集必须在门口拦掉,不能等到 mkdir。
    expect(() => store.create({ id: '../escape', name: 'Bad' })).toThrow(/invalid space id/)
  })

  it('only deletes empty, non-default spaces', () => {
    const store = resetSpacesStoreForTests()
    const scratch = store.create({ id: 'scratch', name: 'Scratch' })

    expect(store.remove(DEFAULT_SPACE_ID)).toEqual({ removed: false, reason: 'default' })
    expect(store.remove(scratch.id, { sessionCount: 3 })).toEqual({
      removed: false,
      reason: 'not-empty',
    })
    expect(store.remove('ghost')).toEqual({ removed: false, reason: 'not-found' })

    expect(store.remove(scratch.id, { sessionCount: 0 })).toEqual({ removed: true })
    expect(store.get(scratch.id)).toBeNull()
    expect(resetSpacesStoreForTests().list().map(s => s.id)).toEqual([DEFAULT_SPACE_ID])
  })

  it('deleting a space takes its whole directory — roster included (批 B4)', async () => {
    const store = resetSpacesStoreForTests()
    const scratch = store.create({ id: 'scratch', name: 'Scratch' })

    // 该空间的名册(批 B4 起住在 workspaces/<id>/project-dirs/)。
    const roster = getProjectsStore(scratch.id)
    roster.add({ path: '/scratch-project', description: '临时' })
    const rosterDir = path.join(tmpDir, scratch.id, 'project-dirs')
    await expect(fs.stat(path.join(rosterDir, 'index.json'))).resolves.toBeTruthy()

    expect(store.remove(scratch.id, { sessionCount: 0 })).toEqual({ removed: true })

    // 目录连坐没了,内存实例也被丢掉 —— 留着它会把索引写回刚删掉的目录。
    await expect(fs.stat(path.join(tmpDir, scratch.id))).rejects.toThrow()
    expect(getProjectsStore(scratch.id)).not.toBe(roster)
    expect(getProjectsStore(scratch.id).list()).toEqual([])
  })

  it('notifies subscribers on every mutation and stops after unsubscribe', () => {
    const store = resetSpacesStoreForTests()
    let hits = 0
    const off = store.subscribe(() => { hits++ })
    const space = store.create({ id: 'notify', name: 'Notify' })
    store.update(space.id, { name: 'Notify 2' })
    store.remove(space.id)
    expect(hits).toBe(3)
    off()
    store.create({ id: 'quiet', name: 'Quiet' })
    expect(hits).toBe(3)
  })

  it('treats a corrupt index as empty rather than half-loaded', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'index.json'),
      JSON.stringify({ spaces: [{ id: 'ok', name: 'Ok', createdAt: 1 }, { id: 'broken' }] }),
      'utf-8',
    )
    const store = resetSpacesStoreForTests()
    expect(store.list().map(space => space.id)).toEqual([DEFAULT_SPACE_ID])
  })
})

describe('space helpers', () => {
  it('defaults a missing/invalid workspaceId to the default space', () => {
    expect(resolveSpaceId(undefined)).toBe(DEFAULT_SPACE_ID)
    expect(resolveSpaceId('')).toBe(DEFAULT_SPACE_ID)
    expect(resolveSpaceId('../evil')).toBe(DEFAULT_SPACE_ID)
    expect(resolveSpaceId('work')).toBe('work')
  })

  it('always sorts the default space first', () => {
    const sorted = sortSpaces([
      { id: 'b', name: 'B', createdAt: 200 },
      { id: DEFAULT_SPACE_ID, name: 'D', createdAt: 999 },
      { id: 'a', name: 'A', createdAt: 100 },
    ])
    expect(sorted.map(space => space.id)).toEqual([DEFAULT_SPACE_ID, 'a', 'b'])
  })
})
