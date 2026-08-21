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
 * 降级:拿不到列表就只剩 default,`available` 为 false,切换器整行不画。
 * (P0.3 起本域走通用 RPC 通道,web 端与桌面同一条 `POST /api/rpc` —— 降级路径
 * 留着兜底,但不再是 web 端的必经之路。)
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  SpaceCredentialImportSkip,
  SpaceCredentialsSummary,
  SpaceOverlayPayload,
  SpaceProviderSettings,
  SpaceRecord,
} from '@shared/ipc'
import { spacesApi } from '@/platform/spaces-client'

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

/**
 * 跨窗口跟随(批 B7)。
 *
 * 「当前空间」是 window 级状态,但**同 origin 的多个窗口共享同一份 localStorage**,
 * 而浏览器/Electron 的 `storage` 事件只在**别的**窗口触发 —— 于是它天然就是
 * 「主窗切了空间,设置窗要知道」这件事的现成通道。不新起 IPC:后端没有「当前
 * 空间」的概念(B1 决策),为一个纯窗口态开一条后端通道等于在后端造第二份真相。
 *
 * 已有先例:`TodoPlanPanel.vue` 用同一手法同步编辑模式。
 */
export function onCurrentSpaceIdChanged(handler: (id: string) => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {}
  }
  const listener = (event: StorageEvent) => {
    // key 为 null = `localStorage.clear()`,那一路也该重读(值会变成 default)。
    if (event.key !== null && event.key !== CURRENT_SPACE_STORAGE_KEY) return
    handler(readStoredSpaceId())
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

export const useSpacesStore = defineStore('spaces', () => {
  const spaces = ref<SpaceRecord[]>(fallbackSpaces())
  const currentSpaceId = ref<string>(readStoredSpaceId())
  // 跨窗口跟随:设置窗/搜索窗是独立 window,主窗切空间后它们必须自己知道
  // (批 B7)。同 origin 共享 localStorage,`storage` 只在别的窗口触发 ——
  // 所以这条订阅不会把自己刚写的值再弹回来。
  onCurrentSpaceIdChanged(id => adoptExternalSpaceId(id))
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
      const response = await spacesApi.list({})
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
      const response = await spacesApi.create({ name: name?.trim() || nextSpaceName() })
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
      const response = await spacesApi.update({ id, name: trimmed })
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
      const response = await spacesApi.remove({ id })
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

  /**
   * 别的窗口切了空间 —— 只认 localStorage 的新值,不回写(回写会把 storage 事件
   * 弹回去)。列表里没有这个 id 时不跟(那多半是这个窗口的列表还没拉到)。
   */
  function adoptExternalSpaceId(id: string): void {
    if (!id || id === currentSpaceId.value) return
    currentSpaceId.value = id
  }

  /* ── overlay(批 B2 起;批 B7 加 selectedModels)──────────────────────────── */

  async function getOverlay(spaceId: string): Promise<SpaceOverlayPayload> {
    try {
      const response = await spacesApi.getOverlay({ id: spaceId })
      if (response.success) return response.overlay ?? {}
      lastError.value = response.error || null
      return {}
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to read overlay'
      return {}
    }
  }

  /**
   * **先读后并**的 overlay 写入。后端那条通道是**整层写**(B2 勘误 3:漏传 = 清空),
   * 从 overlay 长出第二个字段的那一刻起,「只写我关心的那一格」就必须由调用侧
   * 显式合并 —— 否则设置页改一次接入目录就会把 selectedModels 抹掉。
   *
   * 合并只做一层:`patch` 里出现的键整格替换,没出现的键从盘上那份原样带过去。
   */
  async function patchOverlay(
    spaceId: string,
    patch: SpaceOverlayPayload,
  ): Promise<SpaceOverlayPayload | null> {
    try {
      const current = await getOverlay(spaceId)
      // 过线前拆成 plain JSON:调用侧递进来的 patch 往往是从 store 的 reactive 树
      // 上展开的(`{ ...previous, [id]: [...] }` 只拆一层,里面的数组仍是 Vue
      // Proxy),而 Electron 的 invoke 走结构化克隆,Proxy 一律 "could not be
      // cloned" —— 症状是第一次勾选成功、之后每次都回滚闪烁。overlay 本身就是
      // JSON 形状,这一步无损。
      const overlay = JSON.parse(JSON.stringify({ ...current, ...patch })) as SpaceOverlayPayload
      const response = await spacesApi.setOverlay({ id: spaceId, overlay })
      if (!response.success) {
        lastError.value = response.error || 'Failed to save overlay'
        return null
      }
      return response.overlay ?? {}
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to save overlay'
      return null
    }
  }

  /* ── 整套 provider 设置(C2)──────────────────────────────────────────────── */

  /**
   * 读这个空间的 `providers.json`。
   *
   * `null` = 后端答不上话(web 降级 / 这条路由不存在)。**这与「空设置」不是一回事**:
   * 前者要落回 `/api/settings` 那一份,后者就是「这个空间还没配过任何 provider」。
   */
  async function getProviderSettings(spaceId: string): Promise<SpaceProviderSettings | null> {
    try {
      const response = await spacesApi.getProviderSettings({ id: spaceId })
      if (response.success && response.ai) return response.ai
      lastError.value = response.error || null
      return null
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to read provider settings'
      return null
    }
  }

  /** 整层写(与后端同一条口径:传什么就是什么)。 */
  async function setProviderSettings(
    spaceId: string,
    ai: SpaceProviderSettings,
  ): Promise<SpaceProviderSettings | null> {
    try {
      // 过线前拆成 plain JSON:调用侧递进来的往往是从 reactive 树上展开的,
      // Vue Proxy 过不了 Electron 的结构化克隆(见 patchOverlay 的同一句)。
      const payload = JSON.parse(JSON.stringify(ai)) as SpaceProviderSettings
      const response = await spacesApi.setProviderSettings({ id: spaceId, ai: payload })
      if (!response.success) {
        lastError.value = response.error || 'Failed to save provider settings'
        return null
      }
      return response.ai ?? payload
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to save provider settings'
      return null
    }
  }

  /* ── provider 凭证池(批 B3)────────────────────────────────────────────── */

  /** 摘要读:密钥原文永不出后端,这里拿到的只有 hasApiKey + 预览。 */
  async function getCredentials(spaceId: string): Promise<SpaceCredentialsSummary> {
    try {
      const response = await spacesApi.getCredentials({ id: spaceId })
      if (response.success && response.credentials) return response.credentials
      lastError.value = response.error || null
      return { providers: {} }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to read credentials'
      return { providers: {} }
    }
  }

  /**
   * `entryId` 在 = 改那一条,不在 = 往池里追加一条(批 D)。
   *
   * 批 B10:`apiKey` 可选 —— 带 `entryId` 而不带 key = 只改非密钥字段
   * (档位/地区/端点/名称);三个非密钥字段是 patch(缺席 = 沿用旧值)。
   */
  async function setCredential(
    request: {
      id: string
      providerId: string
      apiKey?: string
      baseUrl?: string
      apiMode?: string
      region?: string
      entryId?: string
      label?: string
    },
  ): Promise<SpaceCredentialsSummary | null> {
    try {
      const response = await spacesApi.setCredential(request)
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

  /**
   * 整池写(批 D):排序 + 删除 + 策略一次落盘。传的是 id 列表 —— 渲染层没有
   * 密钥原文,也不该有。
   */
  async function setCredentialPool(
    request: { id: string; providerId: string; entryIds: string[]; policy?: string },
  ): Promise<SpaceCredentialsSummary | null> {
    try {
      const response = await spacesApi.setCredentialPool(request)
      if (!response.success) {
        lastError.value = response.error || 'Failed to update credential pool'
        return null
      }
      return response.credentials ?? { providers: {} }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to update credential pool'
      return null
    }
  }

  async function clearCredential(
    request: { id: string; providerId: string },
  ): Promise<SpaceCredentialsSummary | null> {
    try {
      const response = await spacesApi.clearCredential(request)
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
      const response = await spacesApi.importCredentials({ id: spaceId })
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
    adoptExternalSpaceId,
    create,
    rename,
    remove,
    getOverlay,
    patchOverlay,
    getProviderSettings,
    setProviderSettings,
    getCredentials,
    setCredential,
    setCredentialPool,
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
