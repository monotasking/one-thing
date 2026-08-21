import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  MediaAsset,
  MediaIngestFilesRequest,
  MediaIngestFilesResponse,
  MediaKind,
  MediaQuery,
} from '@/types'
import { platformApi } from '@/platform'
import { mediaApi } from '@/platform/media-client'
import { getLogger } from '@/services/log'
import { mediaFileNameOf, resolveMediaFileSrc } from '@/services/media-src'

const log = getLogger('renderer.media')

export type GeneratedMedia = MediaAsset

function sortNewestFirst(a: MediaAsset, b: MediaAsset) {
  return b.createdAt - a.createdAt
}

/**
 * The stored file name behind a media `filePath`. Since P4c 第三批 both hosts
 * read the SAME record (the media域 rides the generic RPC channel), so this is
 * always a plain absolute path — the decode survives only for values written
 * while the server still rewrote `filePath` into `/api/media/file/<encoded name>`.
 */
function mediaFileNameFromPath(filePath?: string): string {
  const tail = mediaFileNameOf(filePath)
  if (!tail) return ''
  try {
    return decodeURIComponent(tail)
  } catch {
    return tail
  }
}

export const useMediaStore = defineStore('media', () => {
  const mediaItems = ref<MediaAsset[]>([])
  const isLoading = ref(false)
  const isRebuilding = ref(false)
  const hasBackfilled = ref(false)
  const hasLoaded = ref(false)
  let activeLoad: Promise<void> | null = null
  let activeLoadKey = ''

  const assets = computed(() => mediaItems.value)
  const images = computed(() =>
    mediaItems.value.filter(m => m.kind === 'image').sort(sortNewestFirst)
  )

  const kindCounts = computed<Record<MediaKind, number>>(() => ({
    image: mediaItems.value.filter(m => m.kind === 'image').length,
    video: mediaItems.value.filter(m => m.kind === 'video').length,
    audio: mediaItems.value.filter(m => m.kind === 'audio').length,
    document: mediaItems.value.filter(m => m.kind === 'document').length,
    file: mediaItems.value.filter(m => m.kind === 'file').length,
  }))

  async function rebuildLibraryOnce(force = false) {
    if (hasBackfilled.value && !force) return
    isRebuilding.value = true
    try {
      await mediaApi.rebuildLibrary({})
      hasBackfilled.value = true
    } catch (e) {
      log.error('media library rebuild failed', {}, e)
    } finally {
      isRebuilding.value = false
    }
  }

  async function loadMedia(options: { rebuild?: boolean; query?: MediaQuery; force?: boolean } = {}) {
    const queryKey = JSON.stringify(options.query ?? {})
    if (!options.rebuild && !options.force && hasLoaded.value && queryKey === activeLoadKey) return
    if (activeLoad && !options.force && !options.rebuild && queryKey === activeLoadKey) {
      return activeLoad
    }

    activeLoadKey = queryKey
    isLoading.value = true
    const load = (async () => {
      if (options.rebuild) {
        await rebuildLibraryOnce()
      }
      mediaItems.value = await mediaApi.listAssets({ query: options.query })
      hasLoaded.value = true
    })()
    activeLoad = load

    try {
      await load
    } catch (e) {
      log.error('media load failed', {}, e)
    } finally {
      if (activeLoad === load) {
        activeLoad = null
        isLoading.value = false
      }
    }
  }

  async function saveImage(data: {
    url?: string
    base64?: string
    prompt: string
    revisedPrompt?: string
    model: string
    sessionId: string
    messageId: string
  }): Promise<GeneratedMedia | null> {
    try {
      const item = await mediaApi.saveImage(data)
      await loadMedia()
      return mediaItems.value.find(asset => asset.id === item.id) || null
    } catch (e) {
      log.error('image save failed', {}, e)
      return null
    }
  }

  /**
   * Park a picked persona avatar in the media library and hand back the STORED
   * FILE NAME — the reference form `agent.avatarImage` persists (see
   * AgentDefinition). Deliberately not `saveImage` above: that one re-reads the
   * whole library to hand back a `MediaAsset`, and all a caller needs here is
   * the name, which the save response already carries.
   *
   * The `persona-avatar` usage tag is what later tells an avatar apart from
   * generated artwork — the bytes land in the same image store either way.
   *
   * `source: 'user-upload'` is not decoration: until 2026-08 this path left the
   * default `'ai-generated'` in place, so every picked avatar showed up under
   * the「生成」filter. The `model: 'user-upload'` string below was the old,
   * lossy stand-in for the same fact and stays only as the caption.
   */
  async function savePersonaAvatar(data: {
    base64: string
    /** Whose avatar this is — only ever read as the asset's prompt/caption. */
    label?: string
  }): Promise<string | null> {
    try {
      const item = await mediaApi.saveImage({
        base64: data.base64,
        prompt: data.label ? `Agent avatar · ${data.label}` : 'Agent avatar',
        model: 'user-upload',
        sessionId: '',
        messageId: '',
        source: 'user-upload',
        usageTags: ['persona-avatar'],
      })
      const fileName = mediaFileNameFromPath(item?.filePath)
      if (!fileName) return null
      // The library panel would otherwise keep showing a stale list; a failure
      // here must not lose the avatar the caller just successfully stored.
      if (hasLoaded.value) void loadMedia({ force: true })
      return fileName
    } catch (e) {
      log.error('persona avatar save failed', {}, e)
      return null
    }
  }

  /**
   * Put arbitrary files in the library (panel drop / 「选择文件」 / web upload).
   *
   * Refreshing is the CALLER's job, not this action's: the panel holds the live
   * `MediaQuery` (kind/source/search) and a blind `loadMedia()` here would drop
   * back to the unfiltered list right after a drop.
   */
  async function ingestFiles(
    request: MediaIngestFilesRequest,
  ): Promise<MediaIngestFilesResponse> {
    try {
      return await mediaApi.ingestFiles(request)
    } catch (e) {
      log.error('media ingest failed', {}, e)
      return {
        success: false,
        assets: [],
        created: 0,
        skipped: 0,
        errors: [],
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async function removeMedia(id: string) {
    try {
      await mediaApi.hideAsset({ id })
      mediaItems.value = mediaItems.value.filter(m => m.id !== id)
    } catch (e) {
      log.error('media remove failed', { mediaId: id }, e)
    }
  }

  async function clearAll() {
    try {
      await mediaApi.clearAll({})
      mediaItems.value = []
    } catch (e) {
      log.error('media clear failed', {}, e)
    }
  }

  /**
   * 资产 → 本宿主能渲染的 `<img src>`。规则单源于 `services/media-src`(P4c 第三批):
   * 桌面 `media://<name>`,web `/api/media/file/<name>`。从前这一步在 server 壳里
   * 替 web 做掉(`toServerClientMediaAsset` 把每个 `filePath` 改写成那条路由);
   * 媒体域走通用 RPC 之后两边拿到的是同一份记录,于是"用哪种 URL 去取"回到
   * 宿主自己的判断。
   */
  function getImageUrl(media: MediaAsset): string {
    if (!media.filePath) return ''
    return resolveMediaFileSrc(media.filePath, platformApi.environment, media.fileName)
  }

  return {
    mediaItems,
    assets,
    images,
    kindCounts,
    isLoading,
    isRebuilding,
    hasLoaded,
    loadMedia,
    rebuildLibraryOnce,
    saveImage,
    savePersonaAvatar,
    ingestFiles,
    removeMedia,
    clearAll,
    getImageUrl,
  }
})
