// @vitest-environment happy-dom
/**
 * 名册 per-space 在渲染层的一半(批 B4)。
 *
 * 症状是「切换空间的时候项目也带过来了」。后端分家之后,渲染层还剩两条要守:
 * 每次调用都带上当前空间、换空间之后整份重载(Sidebar 的 watch 调 `load()`)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectsStore } from '../projects'
import { DEFAULT_SPACE_ID, useSpacesStore } from '../spaces'

const { electronApi, store: memory } = vi.hoisted(() => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => { store.clear() },
    },
  })
  return {
    store,
    electronApi: {
      projectDirsList: vi.fn(),
      projectDirsAdd: vi.fn(),
      projectDirsUpdate: vi.fn(),
      projectDirsRemove: vi.fn(),
      onSystemThemeChanged: vi.fn(() => vi.fn()),
    },
  }
})

const ROSTERS: Record<string, Array<{ path: string; paths: string[] }>> = {
  default: [{ path: '/home-repo', paths: ['/home-repo'] }],
  work: [{ path: '/work-repo', paths: ['/work-repo', '/work-docs'] }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  memory.clear()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: electronApi })
  electronApi.projectDirsList.mockImplementation(async (workspaceId?: string) => ({
    success: true,
    entries: (ROSTERS[workspaceId ?? DEFAULT_SPACE_ID] ?? []).map(entry => ({
      ...entry,
      description: '',
      lastUsedAt: 0,
    })),
  }))
  electronApi.projectDirsAdd.mockResolvedValue({ success: true, project: { path: '/x' } })
  electronApi.projectDirsUpdate.mockResolvedValue({ success: true, project: { path: '/x' } })
  electronApi.projectDirsRemove.mockResolvedValue({ success: true })
})

describe('projects store × space', () => {
  it('loads the roster of the current space and swaps it wholesale after a switch', async () => {
    const spaces = useSpacesStore()
    const projects = useProjectsStore()

    await projects.load()
    expect(electronApi.projectDirsList).toHaveBeenLastCalledWith(DEFAULT_SPACE_ID)
    expect(projects.entries.map(entry => entry.path)).toEqual(['/home-repo'])
    expect(projects.loadedSpaceId).toBe(DEFAULT_SPACE_ID)

    // 切空间(Sidebar 的 watch 负责调 load;这里直接模拟那一步)。
    spaces.switchTo('work')
    await projects.load()

    expect(electronApi.projectDirsList).toHaveBeenLastCalledWith('work')
    // 上一个空间的项目一条都不该留下 —— 这就是用户报的那个症状。
    expect(projects.entries.map(entry => entry.path)).toEqual(['/work-repo'])
    expect(projects.loadedSpaceId).toBe('work')
  })

  it('stamps the current space on add / update / remove', async () => {
    const spaces = useSpacesStore()
    const projects = useProjectsStore()
    spaces.switchTo('work')
    await projects.load()

    await projects.add('/new-dir', '说明')
    expect(electronApi.projectDirsAdd).toHaveBeenCalledWith(
      '/new-dir',
      '说明',
      undefined,
      'work',
    )

    await projects.addRoot('/work-repo', '/extra')
    expect(electronApi.projectDirsUpdate).toHaveBeenLastCalledWith(
      '/work-repo',
      { paths: ['/work-repo', '/work-docs', '/extra'] },
      'work',
    )

    await projects.setPrimaryRoot('/work-repo', '/work-docs')
    expect(electronApi.projectDirsUpdate).toHaveBeenLastCalledWith(
      '/work-repo',
      { paths: ['/work-docs', '/work-repo'] },
      'work',
    )

    await projects.removeRoot('/work-repo', '/work-docs')
    expect(electronApi.projectDirsUpdate).toHaveBeenLastCalledWith(
      '/work-repo',
      { paths: ['/work-repo'] },
      'work',
    )

    await projects.remove('/work-repo')
    expect(electronApi.projectDirsRemove).toHaveBeenCalledWith('/work-repo', 'work')
  })
})
