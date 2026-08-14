import { forgetProjectsStore } from '../project-dirs/store.js'
import {
  ensureSpaceDir,
  loadIndex,
  removeSpaceDir,
  saveIndex,
} from './persistence.js'
import {
  createDefaultSpace,
  DEFAULT_SPACE_ID,
  isValidSpaceId,
  normalizeSpaceName,
  sortSpaces,
  type Space,
  type SpaceIndex,
} from './types.js'

export class SpacesStore {
  private index: SpaceIndex = { spaces: [] }
  private initialized = false
  private listeners = new Set<() => void>()

  /** 幂等。default space 不存在就补建 —— 它是「缺 workspaceId」的落点,不能缺席。 */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    this.index = loadIndex()
    if (!this.index.spaces.some(space => space.id === DEFAULT_SPACE_ID)) {
      this.index = { spaces: [createDefaultSpace(), ...this.index.spaces] }
      this.persist()
    }
  }

  list(): Space[] {
    this.initialize()
    return sortSpaces(this.index.spaces).map(space => ({ ...space }))
  }

  get(spaceId: string): Space | null {
    this.initialize()
    const hit = this.index.spaces.find(space => space.id === spaceId)
    return hit ? { ...hit } : null
  }

  has(spaceId: string): boolean {
    return this.get(spaceId) !== null
  }

  /**
   * 新建。id 由调用方给(渲染层生成可读 id)或这里派生;重名不拦 —— 空间名是
   * 标签不是主键,拦重名只会逼用户拼数字。
   */
  create(input: { id?: string; name: string; color?: string; icon?: string }): Space {
    this.initialize()
    const name = normalizeSpaceName(input.name)
    if (!name) throw new Error('space requires a non-empty name')
    const id = input.id ?? this.mintId()
    if (!isValidSpaceId(id)) throw new Error(`invalid space id: ${String(input.id)}`)
    if (this.index.spaces.some(space => space.id === id)) {
      throw new Error(`space "${id}" already exists`)
    }
    const space: Space = { id, name, createdAt: Date.now() }
    if (input.color) space.color = input.color
    if (input.icon) space.icon = input.icon
    this.index = { spaces: [...this.index.spaces, space] }
    this.persist()
    ensureSpaceDir(id)
    this.notify()
    return { ...space }
  }

  update(spaceId: string, patch: { name?: string; color?: string; icon?: string }): Space | null {
    this.initialize()
    const existing = this.index.spaces.find(space => space.id === spaceId)
    if (!existing) return null
    const name = patch.name === undefined ? existing.name : normalizeSpaceName(patch.name)
    if (!name) throw new Error('space requires a non-empty name')
    const next: Space = { ...existing, name }
    if (patch.color !== undefined) {
      if (patch.color) next.color = patch.color
      else delete next.color
    }
    if (patch.icon !== undefined) {
      if (patch.icon) next.icon = patch.icon
      else delete next.icon
    }
    this.index = { spaces: this.index.spaces.map(space => (space.id === spaceId ? next : space)) }
    this.persist()
    this.notify()
    return { ...next }
  }

  /**
   * 删除。**只删空的**,且 default 删不掉 —— 会话搬迁不在本切片,
   * 半自动地把别人的会话挪走比拒绝更危险。占用判定由调用方注入
   * (store 不认识会话),缺省视为空。
   *
   * 批 B4 起是**连坐删**:`workspaces/<id>/` 整目录(overlay / credentials /
   * project-dirs 名册)一并抹掉,并丢掉该空间的名册内存实例 —— 留着它就会有一个
   * 幽灵 store 把索引写回刚删掉的目录。
   */
  remove(spaceId: string, options: { sessionCount?: number } = {}): { removed: boolean; reason?: 'not-found' | 'default' | 'not-empty' } {
    this.initialize()
    if (spaceId === DEFAULT_SPACE_ID) return { removed: false, reason: 'default' }
    if (!this.index.spaces.some(space => space.id === spaceId)) {
      return { removed: false, reason: 'not-found' }
    }
    if ((options.sessionCount ?? 0) > 0) return { removed: false, reason: 'not-empty' }
    this.index = { spaces: this.index.spaces.filter(space => space.id !== spaceId) }
    this.persist()
    removeSpaceDir(spaceId)
    forgetProjectsStore(spaceId)
    this.notify()
    return { removed: true }
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  resetForTests(): void {
    this.index = { spaces: [] }
    this.initialized = false
    this.listeners.clear()
  }

  private mintId(): string {
    // 可读 + 唯一:`space-<base36 时间戳><随机>`。id 进路径,所以只用安全字符集。
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `space-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      if (isValidSpaceId(candidate) && !this.index.spaces.some(space => space.id === candidate)) {
        return candidate
      }
    }
    throw new Error('failed to mint a unique space id')
  }

  private persist(): void {
    saveIndex({ spaces: sortSpaces(this.index.spaces) })
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb()
      } catch (err) {
        console.error('[spaces] listener error:', err)
      }
    }
  }
}

let singleton: SpacesStore | null = null

export function getSpacesStore(): SpacesStore {
  if (!singleton) singleton = new SpacesStore()
  return singleton
}

export function resetSpacesStoreForTests(): SpacesStore {
  singleton = new SpacesStore()
  return singleton
}
