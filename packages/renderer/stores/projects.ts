/**
 * 项目名册 store —— 左栏「项目」分组的持久底账。
 *
 * 后端的 project-dirs 子系统早就齐了(`<store>/project-dirs/index.json` +
 * list/add/update/remove 的 IPC 与 `/api/project-dirs` 路由),但渲染层一直没接:
 * 左栏的项目分组是**推导**出来的 —— 会话的 workingDirectory 撞在一起才成一组。
 * 于是「新建一个还没有会话的项目」无处安放:它没有会话,推导不出分组。
 *
 * 这个 store 把那份底账接进来。名册里的项目**不靠会话存在**,空项目照样占一格,
 * 那正是「新建项目 → 在里面开第一个会话」这条路要站的地方。推导出来的项目
 * (老会话带的 cwd)不受影响 —— 两份在 `useSessionOrganizer` 里按目录并起来。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProjectDirSummary } from '@shared/ipc'
import { platformApi } from '@/platform'
import { normalizeProjectDir } from '@/utils/project-dir'
import { currentSpaceId } from './spaces'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.projects')

export const useProjectsStore = defineStore('projects', () => {
  const entries = ref<ProjectDirSummary[]>([])
  const loading = ref(false)
  const lastError = ref<string | null>(null)
  /** 这份 entries 是哪个空间的 —— 换空间后必须整份重载(批 B4:名册 per-space)。 */
  const loadedSpaceId = ref<string>(currentSpaceId())

  /**
   * 名册按空间取(批 B4)。`currentSpaceId()` 是 window 级状态的非组件读法,
   * 读它就不必让这个 store 依赖 spaces store 的实例。
   */
  async function load(): Promise<void> {
    const spaceId = currentSpaceId()
    loadedSpaceId.value = spaceId
    loading.value = true
    try {
      const response = await platformApi.projectDirsList(spaceId)
      if (response.success) {
        entries.value = response.entries ?? []
        lastError.value = null
      } else {
        lastError.value = response.error || 'Failed to load projects'
      }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to load projects'
      log.error('project dirs load failed', {}, error)
    } finally {
      loading.value = false
    }
  }

  /**
   * 登记一个目录。后端对同一路径是 upsert(重复登记只刷新 lastUsedAt),
   * 所以这里不必先查重 —— 用户挑了一个已在名册里的目录,结果是它浮到最前,
   * 而不是一句错误。
   */
  async function add(path: string, description?: string): Promise<boolean> {
    const normalized = normalizeProjectDir(path)
    if (!normalized) return false
    try {
      const response = await platformApi.projectDirsAdd(
        normalized,
        description,
        undefined,
        currentSpaceId(),
      )
      if (!response.success) {
        lastError.value = response.error || 'Failed to add project'
        return false
      }
      await load()
      return true
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to add project'
      log.error('project dir add failed', { path }, error)
      return false
    }
  }

  /**
   * 给已登记的项目再挂一个根。后端 update 的 paths 是整表替换,这里在
   * 现有 paths 上追加;主根(paths[0])不动。
   */
  async function addRoot(projectPath: string, newRoot: string): Promise<boolean> {
    const normalizedRoot = normalizeProjectDir(newRoot)
    if (!normalizedRoot) return false
    const entry = findEntry(projectPath)
    if (!entry) return false
    const currentPaths = entry.paths?.length ? entry.paths : [entry.path]
    if (currentPaths.some(p => normalizeProjectDir(p) === normalizedRoot)) return true
    return await updatePaths(entry.path, [...currentPaths, normalizedRoot])
  }

  /** 摘掉一个副根。主根摘不掉(那是项目的身份锚点,要动主根走整表 update)。 */
  async function removeRoot(projectPath: string, root: string): Promise<boolean> {
    const normalizedRoot = normalizeProjectDir(root)
    const entry = findEntry(projectPath)
    if (!entry || !normalizedRoot) return false
    const currentPaths = entry.paths?.length ? entry.paths : [entry.path]
    if (normalizeProjectDir(entry.path) === normalizedRoot) return false
    const nextPaths = currentPaths.filter(p => normalizeProjectDir(p) !== normalizedRoot)
    if (nextPaths.length === currentPaths.length) return false
    return await updatePaths(entry.path, nextPaths)
  }

  /**
   * 把某个副根提成主根。主根 = `paths[0]` = 会话 cwd 的锚点,所以「设为主根」
   * 就是把它重排到队首后走整表 update —— 后端 update 的 paths 是整表替换、
   * `paths[0]` 即新主根、**项目 id 不变**(批 A 已把 id 与 path 解耦)。
   *
   * 已经是主根的直接算成功:用户点了一下,结果与他想要的一致。
   */
  async function setPrimaryRoot(projectPath: string, root: string): Promise<boolean> {
    const normalizedRoot = normalizeProjectDir(root)
    const entry = findEntry(projectPath)
    if (!entry || !normalizedRoot) return false
    const currentPaths = entry.paths?.length ? entry.paths : [entry.path]
    if (!currentPaths.some(p => normalizeProjectDir(p) === normalizedRoot)) return false
    if (normalizeProjectDir(currentPaths[0]) === normalizedRoot) return true
    const nextPaths = [
      normalizedRoot,
      ...currentPaths.filter(p => normalizeProjectDir(p) !== normalizedRoot),
    ]
    return await updatePaths(entry.path, nextPaths)
  }

  async function updatePaths(primaryPath: string, paths: string[]): Promise<boolean> {
    try {
      const response = await platformApi.projectDirsUpdate(
        primaryPath,
        { paths },
        currentSpaceId(),
      )
      if (!response.success) {
        lastError.value = response.error || 'Failed to update project'
        return false
      }
      await load()
      return true
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to update project'
      log.error('project dirs update failed', { primaryPath }, error)
      return false
    }
  }

  function findEntry(projectPath: string): ProjectDirSummary | undefined {
    const normalized = normalizeProjectDir(projectPath)
    return entries.value.find(entry =>
      (entry.paths?.length ? entry.paths : [entry.path])
        .some(p => normalizeProjectDir(p) === normalized),
    )
  }

  /**
   * 从名册移除。**只是取消登记**:该目录下的会话一条都不动,它们会退回
   * 「推导出来的项目」那条路 —— 还有会话的目录照样成组,只有空项目才真正消失。
   */
  async function remove(path: string): Promise<boolean> {
    const normalized = normalizeProjectDir(path)
    if (!normalized) return false
    try {
      const response = await platformApi.projectDirsRemove(normalized, currentSpaceId())
      if (!response.success) {
        lastError.value = response.error || 'Failed to remove project'
        return false
      }
      entries.value = entries.value.filter(
        entry => normalizeProjectDir(entry.path) !== normalized,
      )
      return true
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to remove project'
      log.error('project dir remove failed', { path }, error)
      return false
    }
  }

  return {
    entries,
    loading,
    lastError,
    loadedSpaceId,
    load,
    add,
    addRoot,
    removeRoot,
    setPrimaryRoot,
    remove,
  }
})
