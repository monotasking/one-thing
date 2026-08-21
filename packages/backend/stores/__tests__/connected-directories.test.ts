import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  sessions: new Map<string, { workspaceId?: string }>(),
  overlays: new Map<string, string[]>(),
}))

vi.mock('../settings.js', () => ({
  getSettings: () => mocks.settings,
}))

// `resolveSessionSpaceId` 批 B3 起住在 sessions.ts(它是会话表的投影,不是目录
// 概念)。这里连它一起替掉 —— 真会话仓库太重,而这两行判据本身在
// spaces/__tests__ 里有真实覆盖。
vi.mock('../sessions.js', async () => {
  const { DEFAULT_SPACE_ID, isValidSpaceId } = await import('@onething/runtime/spaces/types')
  return {
    getSession: (id: string) => mocks.sessions.get(id),
    resolveSessionSpaceId: (id: string | undefined | null) => {
      const workspaceId = id ? mocks.sessions.get(id)?.workspaceId : undefined
      return workspaceId && isValidSpaceId(workspaceId) ? workspaceId : DEFAULT_SPACE_ID
    },
  }
})

// overlay 的落盘/判废在 spaces/__tests__/overlay.test.ts 里测真的;这里只替换
// 「某个 space 登记了哪些目录」这一格,合并/去重规则仍用真实实现。
vi.mock('@onething/runtime/spaces/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/runtime/spaces/overlay')>()
  return {
    ...actual,
    getSpaceOverlayConnectedDirectories: (spaceId: string) => mocks.overlays.get(spaceId) ?? [],
  }
})

import {
  getConnectedDirectories,
  getConnectedDirectoriesForSession,
  getConnectedDirectoriesForSpace,
  listConnectedSkillRoots,
  resolveSessionSpaceId,
} from '../connected-directories.js'

function withConnectedDirectories(dirs: unknown): void {
  mocks.settings = { tools: { connectedDirectories: dirs } }
}

describe('接入目录 —— 五个接线点共用的单一读出口', () => {
  beforeEach(() => {
    mocks.settings = {}
    mocks.sessions = new Map()
    mocks.overlays = new Map()
  })

  describe('getConnectedDirectories', () => {
    it('未配置时是空数组(五件套全部回落到今天的行为)', () => {
      expect(getConnectedDirectories()).toEqual([])

      mocks.settings = { tools: {} }
      expect(getConnectedDirectories()).toEqual([])
    })

    it('读出用户配置的绝对路径,去重后保序', () => {
      withConnectedDirectories(['/Users/me/vault', '/Users/me/work', '/Users/me/vault'])
      expect(getConnectedDirectories()).toEqual(['/Users/me/vault', '/Users/me/work'])
    })

    it('脏值不炸也不流出:非数组、非字符串、空白、相对路径都被挡掉', () => {
      withConnectedDirectories('not-an-array')
      expect(getConnectedDirectories()).toEqual([])

      withConnectedDirectories([null, 7, '', '   ', 'relative/dir', '/Users/me/vault'])
      expect(getConnectedDirectories()).toEqual(['/Users/me/vault'])
    })
  })

  describe('listConnectedSkillRoots —— 复用自定义技能根这条既有链路', () => {
    it('空列表时不产生任何技能根', () => {
      expect(listConnectedSkillRoots()).toEqual([])
    })

    it('每个接入目录投影成一个启用的自定义根', () => {
      withConnectedDirectories(['/Users/me/vault'])

      expect(listConnectedSkillRoots()).toEqual([
        {
          id: 'connected:/Users/me/vault',
          path: '/Users/me/vault',
          label: '/Users/me/vault',
          agentId: null,
          enabled: true,
        },
      ])
    })

    /**
     * id 与路径解耦是这条复用决策的核心收益:技能 id 形如
     * `custom:<dirId>:<相对路径>`,dirId 稳定,用户挪动目录时 settings 里针对
     * 这些技能的启用/绑定覆盖不会变成孤儿。(note-skills 那条链把绝对路径的
     * sha1 编进 id,正是这里要避开的。)
     */
    it('dirId 带 connected: 前缀,与技能页手工加的 dir-<ts>-<rand> 不会相撞', () => {
      withConnectedDirectories(['/Users/me/vault', '/Users/me/work'])

      const ids = listConnectedSkillRoots().map(root => root.id)
      expect(ids).toEqual(['connected:/Users/me/vault', 'connected:/Users/me/work'])
      expect(ids.every(id => id.startsWith('connected:'))).toBe(true)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  /**
   * 三态。红线在第二条:A 空间的会话在跑时用户切到 B,这条流仍须取 A 的目录 ——
   * 判据是**会话归属**,后端根本不持有「当前空间」这个概念。
   */
  describe('getConnectedDirectoriesForSession —— 按会话归属的 space 取', () => {
    it('没有 sessionId:退回纯全局层,不猜当前空间', () => {
      withConnectedDirectories(['/global'])
      mocks.overlays.set('work', ['/work-only'])

      expect(getConnectedDirectoriesForSession(undefined)).toEqual(['/global'])
      expect(getConnectedDirectoriesForSession('')).toEqual(['/global'])
    })

    it('会话归属某个 space:全局 ∪ 该 space 的 overlay,全局在前', () => {
      withConnectedDirectories(['/global'])
      mocks.sessions.set('s-work', { workspaceId: 'work' })
      mocks.overlays.set('work', ['/work-only'])
      mocks.overlays.set('play', ['/play-only'])

      expect(getConnectedDirectoriesForSession('s-work')).toEqual(['/global', '/work-only'])
      // 另一个空间的 overlay 绝不能漏进来
      expect(getConnectedDirectoriesForSession('s-work')).not.toContain('/play-only')
    })

    it('会话缺 workspaceId / 会话不存在 / id 非法:一律按 default 解析', () => {
      withConnectedDirectories(['/global'])
      mocks.sessions.set('s-old', {})
      mocks.sessions.set('s-bad', { workspaceId: '../escape' })
      mocks.overlays.set('default', ['/default-only'])

      expect(resolveSessionSpaceId('s-old')).toBe('default')
      expect(resolveSessionSpaceId('s-bad')).toBe('default')
      expect(resolveSessionSpaceId('s-ghost')).toBe('default')
      expect(getConnectedDirectoriesForSession('s-old')).toEqual(['/global', '/default-only'])
      expect(getConnectedDirectoriesForSession('s-ghost')).toEqual(['/global', '/default-only'])
    })

    it('两层重复的目录只出现一次,且尾斜杠不敏感', () => {
      withConnectedDirectories(['/shared'])
      mocks.sessions.set('s-work', { workspaceId: 'work' })
      mocks.overlays.set('work', ['/shared/', '/work-only', '/work-only/'])

      expect(getConnectedDirectoriesForSession('s-work')).toEqual(['/shared', '/work-only'])
    })

    it('getConnectedDirectoriesForSpace 是同一条合并规则的显式入口', () => {
      withConnectedDirectories(['/global'])
      mocks.overlays.set('work', ['/work-only'])

      expect(getConnectedDirectoriesForSpace('work')).toEqual(['/global', '/work-only'])
      expect(getConnectedDirectoriesForSpace('unknown-space')).toEqual(['/global'])
    })
  })

  it('listConnectedSkillRoots 明确停留在全局层(技能扫描没有会话语境)', () => {
    withConnectedDirectories(['/global'])
    mocks.overlays.set('work', ['/work-only'])

    expect(listConnectedSkillRoots().map(root => root.path)).toEqual(['/global'])
  })
})
