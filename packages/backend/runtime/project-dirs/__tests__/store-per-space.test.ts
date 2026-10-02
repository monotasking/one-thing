/**
 * 名册 per-space(批 B4)。
 *
 * 两个根一起被覆写:default 空间的名册**留在 `<store>/project-dirs/` 原地**
 * (project-dirs 自己的 `setRootDirForTests`),非 default 空间住
 * `workspaces/<id>/project-dirs/`(走 spaces 的 `setRootDirForTests`)。
 * 这正是「零迁移」那条决定在盘上的形状。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  forgetProjectsStore,
  getProjectsStore,
  resetProjectsStoreForTests,
} from '../store.js'
import { projectDirsRoot, setRootDirForTests } from '../persistence.js'
import { setRootDirForTests as setSpacesRootForTests } from '../../spaces/persistence.js'

let legacyRoot: string
let workspacesRoot: string

beforeEach(async () => {
  legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-pd-legacy-'))
  workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-pd-spaces-'))
  setRootDirForTests(legacyRoot)
  setSpacesRootForTests(workspacesRoot)
  resetProjectsStoreForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  setSpacesRootForTests(null)
  resetProjectsStoreForTests()
  await fs.rm(legacyRoot, { recursive: true, force: true })
  await fs.rm(workspacesRoot, { recursive: true, force: true })
})

describe('project-dirs per-space roster', () => {
  it('keeps the default space in place and puts other spaces under workspaces/<id>/', () => {
    expect(projectDirsRoot()).toBe(legacyRoot)
    expect(projectDirsRoot('default')).toBe(legacyRoot)
    expect(projectDirsRoot('work')).toBe(path.join(workspacesRoot, 'work', 'project-dirs'))
    // 非法 id 是路径注入面:落回 default(更严),绝不 mkdir 出去。
    expect(projectDirsRoot('../escape')).toBe(legacyRoot)
  })

  it('hands out one instance per space and folds the default aliases together', () => {
    const fallback = getProjectsStore()
    expect(getProjectsStore('default')).toBe(fallback)
    expect(getProjectsStore(undefined)).toBe(fallback)
    expect(getProjectsStore('../escape')).toBe(fallback)

    const work = getProjectsStore('work')
    expect(work).not.toBe(fallback)
    expect(getProjectsStore('work')).toBe(work)
    expect(work.spaceId).toBe('work')
  })

  it('isolates rosters: the same directory becomes an independent project in each space', async () => {
    const home = getProjectsStore()
    const work = getProjectsStore('work')

    home.add({ path: '/repo', description: '家里的说明' })
    work.add({ path: '/repo', description: '公司的说明' })
    work.add({ path: '/only-at-work' })

    expect(home.list().map(entry => entry.path)).toEqual(['/repo'])
    expect(work.list().map(entry => entry.path).sort()).toEqual(['/only-at-work', '/repo'])
    expect(home.get('/repo')?.description).toBe('家里的说明')
    expect(work.get('/repo')?.description).toBe('公司的说明')
    expect(home.get('/only-at-work')).toBeNull()

    // 落盘也分家:两份 index.json,互不知晓。
    await expect(fs.stat(path.join(legacyRoot, 'index.json'))).resolves.toBeTruthy()
    await expect(
      fs.stat(path.join(workspacesRoot, 'work', 'project-dirs', 'index.json')),
    ).resolves.toBeTruthy()

    // 一个空间里删掉,另一个空间毫发无损。
    expect(work.remove('/repo')).toBe(true)
    expect(work.get('/repo')).toBeNull()
    expect(home.get('/repo')?.description).toBe('家里的说明')
  })

  it('reloads each space from its own disk after the instance table is cleared', () => {
    getProjectsStore().add({ path: '/home-only' })
    getProjectsStore('work').add({ path: '/work-only' })

    resetProjectsStoreForTests()

    expect(getProjectsStore().list().map(e => e.path)).toEqual(['/home-only'])
    expect(getProjectsStore('work').list().map(e => e.path)).toEqual(['/work-only'])
  })

  it('forgetProjectsStore drops the cached instance so a deleted space cannot write back', () => {
    const work = getProjectsStore('work')
    work.add({ path: '/gone' })
    forgetProjectsStore('work')
    expect(getProjectsStore('work')).not.toBe(work)
  })
})
