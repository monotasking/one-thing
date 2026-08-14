/**
 * workdir 变更的自动登记必须落进**会话归属的空间**(批 B4)。
 *
 * 用户实测的症状是「切换空间的时候项目也带过来了」。病根有两半:名册是全局的
 * (已在存储层分家),以及**登记时不看会话归属**——B 空间里跑的会话把项目写进了
 * 所有人共用的那一份。这个文件守的是后半:touch / 派生 roots / 项目级变量 scope
 * 三个消费点都按会话的 space 取名册。
 *
 * 名册用真实存储(tmp 根),不 mock —— 「落在哪个空间」是一句盘上的事实,
 * mock 掉就什么也没验。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessionsById: new Map<string, Record<string, unknown>>(),
  writtenRoots: new Map<string, string[]>(),
}))

vi.mock('../../store.js', () => ({
  getSession: (id: string) => mocks.sessionsById.get(id),
  getSessionsList: () => [...mocks.sessionsById.values()],
  getSettings: () => ({}),
  updateSessionWorkingDirectory: (id: string, workdir: string) => {
    const session = mocks.sessionsById.get(id)
    if (session) session.workingDirectory = workdir
  },
  updateSessionWorkingDirectoryRoots: (id: string, roots: string[]) => {
    mocks.writtenRoots.set(id, roots)
    const session = mocks.sessionsById.get(id)
    if (session) session.workingDirectoryRoots = roots
  },
  updateSessionVariables: () => undefined,
}))

// 会话 → 空间是会话表的一条投影;这里只需要它的口径(缺席 = default)。
vi.mock('../../stores/sessions.js', () => ({
  resolveSessionSpaceId: (id: string | undefined | null) =>
    (id ? (mocks.sessionsById.get(id)?.workspaceId as string | undefined) : undefined) || 'default',
}))

const { workdirGateway, projectStoreGateway } = await import('../gateways.js')
const { getProjectsStore } = await import('@onething/runtime/project-dirs/store')
const { buildProjectDirsPromptVars } = await import('../../project-dirs/index.js')
const { setRootDirForTests } = await import('@onething/runtime/project-dirs/persistence')
const { setRootDirForTests: setSpacesRootForTests } = await import(
  '@onething/runtime/spaces/persistence'
)
const { resetProjectsStoreForTests } = await import('@onething/runtime/project-dirs/store')

let legacyRoot: string
let workspacesRoot: string
let workdirA: string
let workdirB: string

beforeEach(async () => {
  legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-gw-legacy-'))
  workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-gw-spaces-'))
  workdirA = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-gw-dir-a-'))
  workdirB = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-gw-dir-b-'))
  setRootDirForTests(legacyRoot)
  setSpacesRootForTests(workspacesRoot)
  resetProjectsStoreForTests()
  mocks.sessionsById = new Map<string, Record<string, unknown>>([
    ['s-home', { id: 's-home', name: '家里那条' }],
    ['s-work', { id: 's-work', name: '公司那条', workspaceId: 'work' }],
  ])
  mocks.writtenRoots.clear()
})

afterEach(async () => {
  setRootDirForTests(null)
  setSpacesRootForTests(null)
  resetProjectsStoreForTests()
  await Promise.all(
    [legacyRoot, workspacesRoot, workdirA, workdirB].map(dir =>
      fs.rm(dir, { recursive: true, force: true }),
    ),
  )
})

describe('workdir gateway × space', () => {
  it('registers the project into the session\'s own space, not the default one', () => {
    workdirGateway.write('s-work', workdirA, { description: '公司项目' })

    expect(getProjectsStore('work').get(workdirA)).toMatchObject({ description: '公司项目' })
    // default 空间一条都不该多出来 —— 这就是「项目跟着切过来」的病根。
    expect(getProjectsStore().list()).toEqual([])
  })

  it('keeps the same directory as two independent projects across spaces', () => {
    workdirGateway.write('s-home', workdirA, { description: '家里的说明' })
    workdirGateway.write('s-work', workdirA, { description: '公司的说明' })

    expect(getProjectsStore().get(workdirA)?.description).toBe('家里的说明')
    expect(getProjectsStore('work').get(workdirA)?.description).toBe('公司的说明')
  })

  it('derives multi-root sandbox roots from the session space roster only', () => {
    // 只在 work 空间登记成多根项目。
    getProjectsStore('work').add({ path: workdirA, paths: [workdirA, workdirB] })

    workdirGateway.write('s-work', workdirA)
    expect(mocks.writtenRoots.get('s-work')).toEqual([workdirA, workdirB])

    // default 空间的会话看不到那份多根登记:派生结果是空,沙箱边界不该被
    // 另一个空间的项目撑开(空 → 空,连一次写都不该发生)。
    workdirGateway.write('s-home', workdirA)
    expect(mocks.writtenRoots.get('s-home') ?? []).toEqual([])
  })

  it('resolves the project-scoped variable key from the session space roster', () => {
    getProjectsStore('work').add({ path: workdirA, paths: [workdirA, workdirB] })
    mocks.sessionsById.get('s-work')!.workingDirectory = workdirB
    mocks.sessionsById.get('s-home')!.workingDirectory = workdirB

    const workProjectId = getProjectsStore('work').get(workdirB)?.id
    // 副根在 work 空间归到同一个项目 id;default 空间那条没有登记,退回派生 key。
    expect(projectStoreGateway.resolveKey('s-work')).toBe(workProjectId)
    expect(projectStoreGateway.resolveKey('s-home')).not.toBe(workProjectId)
  })

  it('builds prompt vars from the session space roster', () => {
    getProjectsStore().add({ path: workdirA, description: '家里的' })
    getProjectsStore('work').add({ path: workdirB, description: '公司的' })

    const home = buildProjectDirsPromptVars(workdirA, { sessionId: 's-home' })
    expect(home.active).toMatchObject({ hasActive: true, description: '家里的' })
    expect(home.known.entries).toEqual([])

    const work = buildProjectDirsPromptVars(workdirB, { sessionId: 's-work' })
    expect(work.active).toMatchObject({ hasActive: true, description: '公司的' })
    expect(work.known.entries).toEqual([])

    // 同一条 cwd 换个空间问,名册里没有它 —— 提示词不该谎称有个活跃项目。
    expect(buildProjectDirsPromptVars(workdirA, { sessionId: 's-work' }).active).toEqual({
      hasActive: false,
    })
    // 没有 sessionId 就是 default 空间(与所有读取端同一句缺省)。
    expect(buildProjectDirsPromptVars(workdirA).active).toMatchObject({ hasActive: true })
  })
})
