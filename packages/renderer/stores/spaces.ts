/**
 * space(工作空间)store —— 批 B1 骨架。
 *
 * 命名注意:这里是 **space**,不是 `stores/workspace.ts`(那是分栏树)。两者正交:
 * 一个 space 里可以有一棵分栏树,B1 还没把它们接起来。
 *
 * **currentSpaceId 是 window 级状态**:只落 localStorage,不进全局 app-state、
 * 不进后端(设计盲点 4 —— 给「两个窗口开两个 space」留路)。后端所有操作显式
 * 带 id,没有「当前空间」的概念。
 *
 * 降级:拿不到列表(web 端本切片没有 /api/spaces)就只剩 default,
 * `available` 为 false,切换器整行不画。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  SpaceCredentialImportSkip,
  SpaceCredentialsSummary,
  SpaceRecord,
} from '@shared/ipc'
import { platformApi } from '@/platform'

/** 导入结果:失败也如实带回来 —— 建空间成功、导入失败是一个合法的中间态。 */
export interface SpaceCredentialImportOutcome {
  ok: boolean
  imported: string[]
  skipped: SpaceCredentialImportSkip[]
  error?: string
}

export interface CreateSpaceResult {
  space: SpaceRecord
  importResult?: SpaceCredentialImportOutcome
}

export const DEFAULT_SPACE_ID = 'default'
export const DEFAULT_SPACE_NAME = '默认空间'
const CURRENT_SPACE_STORAGE_KEY = 'onething:current-space'

/** 兜底列表:任何时候至少有一个空间可用,UI 不必处理"零个空间"。 */
function fallbackSpaces(): SpaceRecord[] {
  return [{ id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_NAME, createdAt: 0 }]
}

function readStoredSpaceId(): string {
  try {
    return localStorage.getItem(CURRENT_SPACE_STORAGE_KEY) || DEFAULT_SPACE_ID
  } catch {
    return DEFAULT_SPACE_ID
  }
}

function writeStoredSpaceId(id: string): void {
  try {
    localStorage.setItem(CURRENT_SPACE_STORAGE_KEY, id)
  } catch {
    // 隐私模式/配额满:记不住就记不住,不该让切换本身失败。
  }
}

/**
 * 当前空间 id 的**非组件读法**。window 级状态 = localStorage 即真相
 * (`switchTo` 同步写盘),所以不必为了读它去实例化 store —— 建会话/建草稿
 * 这类深处的调用点用这一个函数就够。
 */
export function currentSpaceId(): string {
  return readStoredSpaceId()
}

export const useSpacesStore = defineStore('spaces', () => {
  const spaces = ref<SpaceRecord[]>(fallbackSpaces())
  const currentSpaceId = ref<string>(readStoredSpaceId())
  /** 后端答上话了才算可用;false = 只有 default,切换器不画。 */
  const available = ref(false)
  const loading = ref(false)
  const lastError = ref<string | null>(null)

  const currentSpace = computed<SpaceRecord>(() =>
    spaces.value.find(space => space.id === currentSpaceId.value)
      ?? spaces.value[0]
      ?? fallbackSpaces()[0],
  )

  /** 切换器只在真有第二个空间、且后端可用时才有意义。 */
  const showSwitcher = computed(() => available.value)

  async function load(): Promise<void> {
    loading.value = true
    try {
      const response = await platformApi.spacesList()
      if (response.success && response.spaces?.length) {
        spaces.value = response.spaces
        available.value = true
        lastError.value = null
      } else {
        spaces.value = fallbackSpaces()
        available.value = false
        lastError.value = response.error || null
      }
    } catch (error) {
      spaces.value = fallbackSpaces()
      available.value = false
      lastError.value = error instanceof Error ? error.message : 'Failed to load spaces'
    } finally {
      // 当前空间被别处删掉(或列表降级)时不能停在幽灵 id 上 —— 那会让左栏
      // 过滤成空,看起来像"会话全没了"。
      if (!spaces.value.some(space => space.id === currentSpaceId.value)) {
        switchTo(DEFAULT_SPACE_ID)
      }
      loading.value = false
    }
  }

  function switchTo(id: string): void {
    if (!id || id === currentSpaceId.value) return
    currentSpaceId.value = id
    writeStoredSpaceId(id)
  }

  /** 「空间 N」自动命名:数字取当前数量 + 1,重名不拦(名字是标签不是主键)。 */
  function nextSpaceName(): string {
    return `空间 ${spaces.value.length + 1}`
  }

  async function create(
    name?: string,
    options: { importCredentials?: boolean } = {},
  ): Promise<CreateSpaceResult | null> {
    try {
      const response = await platformApi.spacesCreate({ name: name?.trim() || nextSpaceName() })
      if (!response.success || !response.space) {
        lastError.value = response.error || 'Failed to create space'
        return null
      }
      // 导入是**建完之后的第二步**,不是建的一部分:导入失败不该把刚建好的空间
      // 一起回滚掉(用户要的是空间,凭证可以回设置页再补)。
      let importResult: SpaceCredentialImportOutcome | undefined
      if (options.importCredentials) {
        importResult = await importCredentials(response.space.id)
      }
      await load()
      return { space: response.space, importResult }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to create space'
      return null
    }
  }

  async function rename(id: string, name: string): Promise<boolean> {
    const trimmed = name.trim()
    if (!trimmed) return false
    try {
      const response = await platformApi.spacesUpdate({ id, name: trimmed })
      if (!response.success) {
        lastError.value = response.error || 'Failed to rename space'
        return false
      }
      await load()
      return true
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to rename space'
      return false
    }
  }

  /** 只删得掉空的、非 default 的空间;后端拒绝时把理由留在 lastError 上。 */
  async function remove(id: string): Promise<boolean> {
    try {
      const response = await platformApi.spacesRemove(id)
      if (!response.success) {
        lastError.value = response.error || 'Failed to remove space'
        return false
      }
      if (currentSpaceId.value === id) switchTo(DEFAULT_SPACE_ID)
      await load()
      return true
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to remove space'
      return false
    }
  }

  /* ── provider 凭证池(批 B3)────────────────────────────────────────────── */

  /** 摘要读:密钥原文永不出后端,这里拿到的只有 hasApiKey + 预览。 */
  async function getCredentials(spaceId: string): Promise<SpaceCredentialsSummary> {
    try {
      const response = await platformApi.spacesGetCredentials(spaceId)
      if (response.success && response.credentials) return response.credentials
      lastError.value = response.error || null
      return { providers: {} }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to read credentials'
      return { providers: {} }
    }
  }

  async function setCredential(
    request: { id: string; providerId: string; apiKey: string; baseUrl?: string },
  ): Promise<SpaceCredentialsSummary | null> {
    try {
      const response = await platformApi.spacesSetCredential(request)
      if (!response.success) {
        lastError.value = response.error || 'Failed to save credential'
        return null
      }
      return response.credentials ?? { providers: {} }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to save credential'
      return null
    }
  }

  async function clearCredential(
    request: { id: string; providerId: string },
  ): Promise<SpaceCredentialsSummary | null> {
    try {
      const response = await platformApi.spacesClearCredential(request)
      if (!response.success) {
        lastError.value = response.error || 'Failed to clear credential'
        return null
      }
      return response.credentials ?? { providers: {} }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to clear credential'
      return null
    }
  }

  /** 从默认空间导入凭证快照(copy 不引用)。OAuth 型跳过,原样报回给调用方。 */
  async function importCredentials(spaceId: string): Promise<SpaceCredentialImportOutcome> {
    try {
      const response = await platformApi.spacesImportCredentials(spaceId)
      if (!response.success) {
        lastError.value = response.error || 'Failed to import credentials'
        return { ok: false, imported: [], skipped: [], error: response.error }
      }
      return {
        ok: true,
        imported: response.imported ?? [],
        skipped: response.skipped ?? [],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import credentials'
      lastError.value = message
      return { ok: false, imported: [], skipped: [], error: message }
    }
  }

  return {
    spaces,
    currentSpaceId,
    currentSpace,
    available,
    showSwitcher,
    loading,
    lastError,
    load,
    switchTo,
    create,
    rename,
    remove,
    getCredentials,
    setCredential,
    clearCredential,
    importCredentials,
  }
})

/**
 * 会话归属判定 —— **缺 workspaceId = default**,读取端缺省,零迁移。
 * 左栏过滤、删空间的占用统计都走这一句,别各写各的。
 */
export function sessionBelongsToSpace(
  session: { workspaceId?: string },
  spaceId: string,
): boolean {
  return (session.workspaceId || DEFAULT_SPACE_ID) === (spaceId || DEFAULT_SPACE_ID)
}
