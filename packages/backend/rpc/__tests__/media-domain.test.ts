/**
 * media 域,端到端穿过 dispatcher(结构债 P4c 第三批)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/media.ts` 工厂里那十一条
 * (连同 `__tests__/media.test.ts` 里对应的断言)、`@main/ipc/media.ts` 的壳适配、
 * bridge 上那十一条包装,以及 server 的十一条 REST 路由 + media facade adapter 的
 * 十一个方法。
 *
 * 只桩**库本体**(`library-service-bound` 那台单例)与会话表,**投影不桩** ——
 * `@onething/runtime/media` 的那批 `*OnethingMedia*` / `*ForIpc` 是真跑的,所以这组
 * 用例证的是「域把端口接对了」,而不是「域自己又实现了一遍」。
 *
 * 值得钉的三件:
 *  - 十一条方法都在 router 的白名单上,一条不多一条不少 —— 尤其是**没有**
 *    `saveAs` / `openPreview` / `openGallery`:那三条要宿主本体,按 P4 终态留在
 *    手写通道上;
 *  - `getPreview` 读的是那本**进程内**登记簿,而写它的是留在宿主侧的「开预览窗」——
 *    两半共用 `@onething/runtime/media/image-preview-registry-bound` 的同一个单例,
 *    这条用例就是它们仍然是同一本簿子的判据;
 *  - `readImageBase64` 收的是**绝对路径**。从前 web 那一侧收的是
 *    `/api/media/file/<name>`(server 壳改写过 `filePath`),迁移之后两边读同一份
 *    记录、拿到同一个绝对路径,"该用哪种 URL 去渲染"才回到渲染侧按 environment 判断。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imagePreviewRegistry } from '@onething/runtime/media/image-preview-registry-bound'
import { openOnethingImagePreviewForIpc } from '@onething/runtime/media'

const library = vi.hoisted(() => ({
  listAssets: vi.fn(),
  ingestLocalFiles: vi.fn(),
  hideAsset: vi.fn(),
  hideAllAssets: vi.fn(),
  rebuildFromSessions: vi.fn(),
  getGallery: vi.fn(),
  listLegacyImages: vi.fn(),
  saveGeneratedImageAsLegacyItem: vi.fn(),
}))

const stores = vi.hoisted(() => ({
  getSessions: vi.fn(() => []),
}))

vi.mock('@onething/runtime/media/library-service-bound', () => ({
  mediaLibraryService: library,
}))
vi.mock('../../stores/index.js', () => stores)

const ASSET = {
  id: 'asset-1',
  kind: 'image' as const,
  source: 'ai-generated' as const,
  mimeType: 'image/png',
  size: 12,
  fileName: 'a.png',
  filePath: '/store/media/images/a.png',
  links: [],
  createdAt: 1,
}

const LEGACY_ITEM = {
  id: 'item-1',
  type: 'image' as const,
  filePath: '/store/media/images/a.png',
  prompt: 'a cat',
  model: 'gpt-image',
  createdAt: 1,
  sessionId: 'session-1',
  messageId: 'message-1',
}

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerMediaRpcDomain }] =
    await Promise.all([import('../registry.js'), import('../domains/media.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerMediaRpcDomain }
}

describe('media RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    for (const fn of Object.values(library)) fn.mockReset()
    library.listAssets.mockResolvedValue([ASSET])
    library.hideAsset.mockResolvedValue(true)
    library.hideAllAssets.mockResolvedValue(undefined)
    library.rebuildFromSessions.mockResolvedValue({ added: 2, skipped: 1 })
    library.getGallery.mockResolvedValue({ images: [ASSET], currentIndex: 0 })
    library.listLegacyImages.mockResolvedValue([LEGACY_ITEM])
    library.saveGeneratedImageAsLegacyItem.mockResolvedValue(LEGACY_ITEM)
    library.ingestLocalFiles.mockResolvedValue({
      assets: [ASSET], created: 1, skipped: 0, errors: [],
    })
    stores.getSessions.mockReset().mockReturnValue([])
    imagePreviewRegistry.clear()

    const { resetRpcRegistryForTests, registerMediaRpcDomain } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerMediaRpcDomain()
  })

  afterEach(async () => {
    dispose?.()
    dispose = undefined
    const { resetRpcRegistryForTests } = await loadDomain()
    resetRpcRegistryForTests()
    imagePreviewRegistry.clear()
    vi.restoreAllMocks()
  })

  it('exposes exactly the eleven data-plane methods — and none of the three host-residual ones', async () => {
    const { mediaRouter } = await import('@shared/ipc/media.js')
    expect([...mediaRouter.methods]).toEqual([
      'listAssets',
      'ingestFiles',
      'hideAsset',
      'rebuildLibrary',
      'getGallery',
      'saveImage',
      'loadAll',
      'delete',
      'clearAll',
      'readImageBase64',
      'getPreview',
    ])
    for (const hostResidual of ['saveAs', 'openPreview', 'openGallery']) {
      expect(mediaRouter.methods).not.toContain(hostResidual)
    }
  })

  it('routes the library reads and writes onto the one bound media service', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(
      dispatchRpc({ domain: 'media', method: 'listAssets', payload: { query: { kind: 'image' } } }),
    ).resolves.toEqual({ ok: true, data: [ASSET] })
    expect(library.listAssets).toHaveBeenCalledWith({ kind: 'image' })

    await expect(
      dispatchRpc({ domain: 'media', method: 'hideAsset', payload: { id: 'asset-1' } }),
    ).resolves.toEqual({ ok: true, data: { success: true } })

    await expect(
      dispatchRpc({ domain: 'media', method: 'getGallery', payload: { assetId: 'asset-1' } }),
    ).resolves.toEqual({ ok: true, data: { images: [ASSET], currentIndex: 0 } })

    await expect(
      dispatchRpc({ domain: 'media', method: 'loadAll', payload: {} }),
    ).resolves.toEqual({ ok: true, data: [LEGACY_ITEM] })

    await expect(
      dispatchRpc({ domain: 'media', method: 'delete', payload: { id: 'item-1' } }),
    ).resolves.toEqual({ ok: true, data: true })

    await dispatchRpc({ domain: 'media', method: 'clearAll', payload: {} })
    expect(library.hideAllAssets).toHaveBeenCalled()

    // rebuild 读的是**装配层的会话表**,不是它自己缓存的一份。
    await expect(
      dispatchRpc({ domain: 'media', method: 'rebuildLibrary', payload: {} }),
    ).resolves.toEqual({ ok: true, data: { success: true, added: 2, skipped: 1 } })
    expect(stores.getSessions).toHaveBeenCalled()
  })

  it('saves a generated image through the same library the engine writes to', async () => {
    const { dispatchRpc } = await loadDomain()
    const request = {
      base64: 'aW1hZ2U=',
      prompt: 'a cat',
      model: 'gpt-image',
      sessionId: 'session-1',
      messageId: 'message-1',
      source: 'user-upload' as const,
      usageTags: ['persona-avatar' as const],
    }
    await expect(
      dispatchRpc({ domain: 'media', method: 'saveImage', payload: request }),
    ).resolves.toEqual({ ok: true, data: LEGACY_ITEM })
    expect(library.saveGeneratedImageAsLegacyItem).toHaveBeenCalledWith(request)
  })

  it('reads an image off an ABSOLUTE path — the shape both hosts now receive', async () => {
    const { dispatchRpc } = await loadDomain()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-media-domain-'))
    const file = path.join(dir, 'pixel.png')
    fs.writeFileSync(file, Buffer.from('89504e47', 'hex'))
    try {
      await expect(
        dispatchRpc({ domain: 'media', method: 'readImageBase64', payload: { filePath: file } }),
      ).resolves.toEqual({ ok: true, data: 'data:image/png;base64,iVBORw==' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the SAME preview ledger the host-side 「开预览窗」 writes', async () => {
    const { dispatchRpc } = await loadDomain()
    const openPreviewWindow = vi.fn(async () => {})
    // 宿主那半:`@main/ipc/media.ts` 逐字这样调。
    const opened = await openOnethingImagePreviewForIpc({
      registry: imagePreviewRegistry,
      src: 'media://a.png',
      alt: 'a cat',
      openPreviewWindow,
    })
    expect(opened.success).toBe(true)
    const previewId = opened.success ? opened.previewId : ''

    await expect(
      dispatchRpc({ domain: 'media', method: 'getPreview', payload: { previewId } }),
    ).resolves.toEqual({ ok: true, data: { success: true, src: 'media://a.png', alt: 'a cat' } })

    await expect(
      dispatchRpc({ domain: 'media', method: 'getPreview', payload: { previewId: 'nope' } }),
    ).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'Image preview expired or was not found' },
    })
  })

  it('rejects a method that is not on the router allowlist', async () => {
    const { dispatchRpc } = await loadDomain()
    const response = await dispatchRpc({ domain: 'media', method: 'saveAs', payload: {} })
    expect(response.ok).toBe(false)
  })
})
