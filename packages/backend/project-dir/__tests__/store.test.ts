import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetProjectsStoreForTests } from '../store.js'
import { setRootDirForTests } from '../persistence.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-projects-store-'))
  setRootDirForTests(tmpDir)
})

afterEach(async () => {
  setRootDirForTests(null)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('Onething project dirs store', () => {
  it('lists, adds, gets, updates, removes, and persists projects', async () => {
    const store = resetProjectsStoreForTests()
    expect(store.list()).toEqual([])

    const first = store.add({ path: '/foo', description: 'Foo' })
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = store.add({ path: '/bar', description: 'Bar' })

    expect(first.id).toMatch(/^[0-9a-f]{16}$/)
    expect(store.list().map(entry => entry.path)).toEqual(['/bar', '/foo'])
    expect(store.get('/foo')).toMatchObject({ path: '/foo', description: 'Foo' })

    const updated = store.update('/foo', { description: 'Foo updated' })
    expect(updated?.description).toBe('Foo updated')
    expect(store.get('/foo')?.description).toBe('Foo updated')

    expect(store.remove(second.path)).toBe(true)
    expect(store.remove(second.path)).toBe(false)

    const nextStore = resetProjectsStoreForTests()
    expect(nextStore.list().map(entry => entry.path)).toEqual(['/foo'])
    expect(nextStore.get('/foo')?.description).toBe('Foo updated')
  })

  it('touch creates with fallback and preserves existing descriptions', async () => {
    const store = resetProjectsStoreForTests()
    expect(store.touch('/p', 'First').description).toBe('First')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(store.touch('/p', 'Second').description).toBe('First')
  })

  it('supports multi-root projects: any-root lookup, id stability, root management', async () => {
    const store = resetProjectsStoreForTests()

    const created = store.add({ path: '/main', paths: ['/extra', '/main/'], description: 'Multi' })
    expect(created.path).toBe('/main')
    expect(created.paths).toEqual(['/main', '/extra'])

    // Any-root lookup resolves to the same project.
    expect(store.get('/extra')?.id).toBe(created.id)
    expect(store.get('/extra/')?.id).toBe(created.id)

    // Touching a secondary root refreshes the project without rewriting identity.
    await new Promise(resolve => setTimeout(resolve, 5))
    const touched = store.touch('/extra', 'ignored fallback')
    expect(touched.id).toBe(created.id)
    expect(touched.path).toBe('/main')
    expect(touched.description).toBe('Multi')
    expect(touched.lastUsedAt).toBeGreaterThan(created.lastUsedAt)

    // Root-list replacement re-anchors the primary while the id stays put.
    const rerooted = store.update('/extra', { paths: ['/extra', '/third'] })
    expect(rerooted?.id).toBe(created.id)
    expect(rerooted?.path).toBe('/extra')
    expect(rerooted?.paths).toEqual(['/extra', '/third'])
    expect(store.get('/main')).toBeNull()

    // Adding an already-owned root upserts instead of minting a second project.
    const upserted = store.add({ path: '/third' })
    expect(upserted.id).toBe(created.id)
    expect(store.list()).toHaveLength(1)

    // Removing by any root drops the whole project.
    expect(store.remove('/third')).toBe(true)
    expect(store.list()).toEqual([])

    expect(() => store.update('/nope', { paths: [] })).not.toThrow()
  })

  it('reads legacy single-path records as single-root projects', async () => {
    const store = resetProjectsStoreForTests()
    const legacy = store.add({ path: '/legacy', description: 'L' })
    // Simulate a pre-multi-root record: strip `paths` from both disk shapes.
    const dataFile = path.join(tmpDir, 'data', `${legacy.id}.json`)
    const record = JSON.parse(await fs.readFile(dataFile, 'utf-8'))
    delete record.paths
    await fs.writeFile(dataFile, JSON.stringify(record), 'utf-8')
    const indexFile = path.join(tmpDir, 'index.json')
    const index = JSON.parse(await fs.readFile(indexFile, 'utf-8'))
    for (const entry of index.projects) delete entry.paths
    await fs.writeFile(indexFile, JSON.stringify(index), 'utf-8')

    const reloaded = resetProjectsStoreForTests()
    expect(reloaded.list()).toMatchObject([{ path: '/legacy', paths: ['/legacy'] }])
    expect(reloaded.get('/legacy')).toMatchObject({ paths: ['/legacy'], description: 'L' })
  })

  it('rejects empty paths and notifies subscribers on mutations', () => {
    const store = resetProjectsStoreForTests()
    let count = 0
    const off = store.subscribe(() => count++)

    expect(() => store.add({ path: '   ' })).toThrow(/non-empty path/)
    store.add({ path: '/a' })
    store.update('/a', { description: 'A' })
    store.remove('/a')
    expect(count).toBe(3)

    off()
    store.add({ path: '/b' })
    expect(count).toBe(3)
  })
})
