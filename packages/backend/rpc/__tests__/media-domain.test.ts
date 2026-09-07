import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnethingMediaLibraryService, OnethingImagePreviewRegistry, type OnethingMediaAsset, type OnethingMediaSession } from '@onething/runtime/media'
import { mediaRouter } from '@shared/ipc/media.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { createSessionAccess } from '../../session/access.js'
import { configureHostLocalTrust } from '../../server/host-trust.js'
import { createServerMediaDelivery } from '../../server/media-delivery.js'
import { createMediaRpcHandlers } from '../domains/media.js'
import { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests } from '../registry.js'

describe('media RPC authorization with the actual library', () => {
  let dir: string
  let library: OnethingMediaLibraryService
  let previews: OnethingImagePreviewRegistry
  let dispose: () => void
  let restoreTrust: () => void
  let bodyRead: ReturnType<typeof vi.fn<(id: string) => OnethingMediaSession>>
  const records = new Map<string, { id: string; ownerUserId?: string; ownerWorkspaceId?: string }>()
  const access = createSessionAccess({ findMeta: id => records.get(id) })
  const rpc = (method: string, payload: unknown = {}, context: RpcDispatchContext = DESKTOP_RPC_CONTEXT) => dispatchRpc({ domain: 'media', method, payload }, context)
  const actor = (ownerUid = 'alice', workspaceId = 'a'): RpcDispatchContext => ({ transport: 'http', ownerUid, workspaceId, sandboxRoot: path.join(dir, ownerUid, workspaceId) })
  async function image(sessionId: string, bytes = sessionId) {
    return library.ingestGeneratedImage({ sessionId, messageId: `${sessionId}-message`, base64: Buffer.from(bytes).toString('base64'), prompt: `${sessionId} private prompt`, model: 'image' })
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-access-'))
    library = new OnethingMediaLibraryService({ indexPath: path.join(dir, 'index.json'), imagesDir: path.join(dir, 'images'), filesDir: path.join(dir, 'files') })
    records.clear()
    records.set('local', { id: 'local' })
    records.set('alice-a', { id: 'alice-a', ownerUserId: 'alice', ownerWorkspaceId: 'a' })
    records.set('alice-b', { id: 'alice-b', ownerUserId: 'alice', ownerWorkspaceId: 'b' })
    records.set('bob-a', { id: 'bob-a', ownerUserId: 'bob', ownerWorkspaceId: 'a' })
    bodyRead = vi.fn((id: string) => ({ id, messages: [] }))
    let id = 0
    previews = new OnethingImagePreviewRegistry({ createId: () => `preview-${++id}` })
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(mediaRouter, createMediaRpcHandlers({ library, access, listSessions: () => [...records.values()], getSession: bodyRead, previews }))
    restoreTrust = configureHostLocalTrust({ origin: 'desktop-embedded' })
  })
  afterEach(() => {
    dispose(); restoreTrust(); resetRpcRegistryForTests(); vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('retains all eleven data methods and excludes native window actions', () => {
    expect([...mediaRouter.methods]).toEqual(['listAssets', 'ingestFiles', 'hideAsset', 'rebuildLibrary', 'getGallery', 'saveImage', 'loadAll', 'delete', 'clearAll', 'readImageBase64', 'getPreview'])
  })

  it('checks source metadata before searching prompts or projecting legacy images', async () => {
    const own = await image('alice-a')
    const foreign = await image('bob-a')
    await image('alice-b')
    Object.defineProperty(foreign, 'metadata', { configurable: true, get() { throw new Error('foreign prompt read') } })
    expect(await rpc('listAssets', { query: { search: 'private' } }, actor())).toEqual({ ok: true, data: [own] })
    expect(await rpc('getGallery', { assetId: own.id }, actor())).toEqual({ ok: true, data: { images: [own], currentIndex: 0 } })
    const result = await rpc('loadAll', {}, actor())
    expect(result).toMatchObject({ ok: true, data: [{ id: own.id, sessionId: 'alice-a' }] })
    expect(await rpc('getGallery', { assetId: foreign.id }, actor())).toMatchObject({ ok: false })
    expect(bodyRead).not.toHaveBeenCalled()
  })

  it('keeps all source links authoritative, including deleted and unknown sessions', async () => {
    const mixed = await image('alice-a')
    mixed.links.push({ sessionId: 'bob-a' })
    const orphan = await image('alice-b')
    records.delete('alice-b')
    for (const context of [actor(), DESKTOP_RPC_CONTEXT]) {
      expect(await rpc('listAssets', {}, context)).toEqual({ ok: true, data: [] })
      for (const asset of [mixed, orphan]) {
        expect(await rpc('getGallery', { assetId: asset.id }, context)).toMatchObject({ ok: false })
        expect(await rpc('hideAsset', { id: asset.id }, context)).toMatchObject({ ok: false })
      }
    }
    expect(library.getAsset(mixed.id)?.libraryHiddenAt).toBeUndefined()
  })

  it('denies bytes before reading files and rejects cross-owner, cross-tenant and symlink paths', async () => {
    const own = await image('alice-a')
    const foreign = await image('bob-a')
    const otherTenant = await image('alice-b')
    const read = vi.spyOn(fs, 'readFileSync')
    for (const filePath of [foreign.filePath, otherTenant.filePath]) expect(await rpc('readImageBase64', { filePath }, actor())).toMatchObject({ ok: false })
    expect(read).not.toHaveBeenCalled()
    expect(await rpc('readImageBase64', { filePath: own.filePath }, actor())).toEqual({ ok: true, data: `data:image/png;base64,${Buffer.from('alice-a').toString('base64')}` })
    fs.mkdirSync(actor().sandboxRoot!, { recursive: true })
    const alias = path.join(actor().sandboxRoot!, 'foreign.png')
    fs.symlinkSync(foreign.filePath!, alias)
    read.mockClear()
    expect(await rpc('readImageBase64', { filePath: alias }, actor())).toMatchObject({ ok: false })
    expect(read).not.toHaveBeenCalled()
  })

  it('preflights every clear/rebuild target with zero body reads or writes on mixed ownership', async () => {
    const own = await image('alice-a')
    await image('bob-a')
    const writes = vi.spyOn(fs, 'writeFileSync')
    expect(await rpc('clearAll', {}, actor())).toMatchObject({ ok: false })
    expect(await rpc('rebuildLibrary', {}, actor())).toMatchObject({ ok: false })
    expect(bodyRead).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(library.getAsset(own.id)?.libraryHiddenAt).toBeUndefined()
  })

  it('still rebuilds and clears an entirely authorized local library', async () => {
    records.clear(); records.set('local', { id: 'local' })
    bodyRead.mockReturnValue({ id: 'local', messages: [{ id: 'm', role: 'user', attachments: [{ id: 'att', fileName: 'pixel.png', mimeType: 'image/png', mediaType: 'image', size: 5, base64Data: 'aW1hZ2U=' }] }] })
    expect(await rpc('rebuildLibrary')).toEqual({ ok: true, data: { success: true, added: 1, skipped: 0 } })
    const asset = library.listAssets()[0]
    expect(await rpc('hideAsset', { id: asset.id })).toEqual({ ok: true, data: { success: true } })
    expect(await rpc('delete', { id: asset.id })).toEqual({ ok: true, data: true })
    expect(await rpc('clearAll')).toEqual({ ok: true, data: null })
  })

  it('checks all import links and paths before the first read or side effect', async () => {
    const root = actor().sandboxRoot!
    fs.mkdirSync(root, { recursive: true })
    const good = path.join(root, 'good.png')
    const outside = path.join(dir, 'outside.png')
    fs.writeFileSync(good, 'good'); fs.writeFileSync(outside, 'outside')
    const alias = path.join(root, 'escape.png'); fs.symlinkSync(outside, alias)
    library.listAssetAccess()
    const read = vi.spyOn(fs, 'readFileSync'), write = vi.spyOn(fs, 'writeFileSync')
    for (const payload of [
      { files: [{ filePath: good, fileName: 'good.png' }], links: [{ sessionId: 'alice-a' }, { sessionId: 'bob-a' }] },
      { files: [{ filePath: good, fileName: 'good.png' }, { filePath: alias, fileName: 'escape.png' }] },
    ]) expect(await rpc('ingestFiles', payload, actor())).toMatchObject({ ok: false })
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  })

  it('stamps independent upload ownership in its first index write and partitions deduplication', async () => {
    const payload = { files: [{ fileName: 'pixel.png', base64Data: 'aW1hZ2U=' }], ownerUserId: 'bob', ownerWorkspaceId: 'a' }
    const first = await rpc('ingestFiles', payload, actor())
    expect(first).toMatchObject({ ok: true, data: { created: 1, assets: [{ ownerUserId: 'alice', ownerWorkspaceId: 'a', links: [] }] } })
    expect(await rpc('ingestFiles', payload, actor())).toMatchObject({ ok: true, data: { skipped: 1 } })
    expect(await rpc('ingestFiles', payload, actor('bob'))).toMatchObject({ ok: true, data: { created: 1 } })
    expect(await rpc('ingestFiles', payload, actor('alice', 'b'))).toMatchObject({ ok: true, data: { created: 1 } })
    const restored = new OnethingMediaLibraryService(library.storagePaths())
    expect(restored.listAssets()).toHaveLength(3)
    expect(new Set(restored.listAssets().map(asset => `${asset.ownerUserId}/${asset.ownerWorkspaceId}`))).toEqual(new Set(['alice/a', 'alice/b', 'bob/a']))
    expect(await rpc('listAssets', {}, actor())).toMatchObject({ ok: true, data: [{ ownerUserId: 'alice', ownerWorkspaceId: 'a' }] })
  })

  it('does not merge identical generated or attached bytes across source sessions', async () => {
    const first = await image('alice-a', 'same')
    const second = await image('bob-a', 'same')
    expect(first.id).not.toBe(second.id)
    expect(first.links.map(link => link.sessionId)).toEqual(['alice-a'])
    const attachment = { id: 'a', fileName: 'a.png', mimeType: 'image/png', mediaType: 'image' as const, size: 4, base64Data: 'c2FtZQ==' }
    const a = library.ingestAttachment({ sessionId: 'alice-a', messageId: 'm', role: 'user', attachment })!
    const b = library.ingestAttachment({ sessionId: 'bob-a', messageId: 'm', role: 'user', attachment })!
    expect(a.id).not.toBe(b.id)
    const write = vi.spyOn(fs, 'writeFileSync')
    expect(await rpc('saveImage', { sessionId: 'bob-a', messageId: 'm', base64: 'c2FtZQ==', prompt: 'spoofed', model: 'm' }, actor())).toMatchObject({ ok: false })
    expect(write).not.toHaveBeenCalled()
    expect(await rpc('saveImage', { sessionId: 'alice-a', messageId: 'm2', base64: 'c2FtZQ==', prompt: 'own', model: 'm' }, actor())).toMatchObject({ ok: true, data: { id: first.id } })
  })

  it('keeps native previews local and validates source assets before returning their content', async () => {
    const local = await image('local'), foreign = await image('bob-a')
    const ownPreview = previews.create(`media://${path.basename(local.filePath!)}`, 'local')
    const foreignPreview = previews.create(`media://${path.basename(foreign.filePath!)}`, 'secret')
    expect(await rpc('getPreview', { previewId: ownPreview })).toMatchObject({ ok: true, data: { success: true, alt: 'local' } })
    expect(await rpc('getPreview', { previewId: foreignPreview })).toMatchObject({ ok: false })
    const lookup = vi.spyOn(previews, 'get')
    expect(await rpc('getPreview', { previewId: ownPreview }, actor())).toMatchObject({ ok: false })
    expect(lookup).not.toHaveBeenCalled()
    expect(await rpc('getPreview', { previewId: 'missing' })).toMatchObject({ ok: true, data: { success: false } })
  })

  it('rechecks source ownership after an actual download and before storing generated bytes', async () => {
    let release!: () => void, started!: () => void
    const receiving = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const server = createServer(async (_request, response) => { started(); await gate; response.end('downloaded') })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const saving = rpc('saveImage', { sessionId: 'alice-a', messageId: 'm', prompt: 'image', model: 'image', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/image` }, actor())
      await receiving
      records.get('alice-a')!.ownerUserId = 'bob'
      release()
      expect(await saving).toMatchObject({ ok: false })
      expect(fs.existsSync(library.storagePaths().indexPath)).toBe(false)
      expect(fs.existsSync(library.storagePaths().imagesDir)).toBe(false)
    } finally { release(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('serves bytes through the actual delivery adapter with the same all-source rule', async () => {
    const own = await image('alice-a'), foreign = await image('bob-a'), mixed = await image('alice-a', 'mixed')
    mixed.links.push({ sessionId: 'bob-a' })
    const delivery = createServerMediaDelivery({ defaultContext: () => ({ userId: 'alice', workspaceId: 'a' }), ownerKey: context => `${context.userId}/${context.workspaceId}`, libraryPaths: () => ({ indexPath: path.join(dir, 'old/index.json'), imagesDir: path.join(dir, 'old/images'), filesDir: path.join(dir, 'old/files') }), sharedLibrary: library, access })
    const file = (asset: OnethingMediaAsset) => `/api/media/file/${path.basename(asset.filePath!)}`
    try {
      const result = await delivery.adapter.resolveFile!(file(own))
      expect(result).toMatchObject({ success: true, path: fs.realpathSync(own.filePath!) })
      if (result.success && result.path) expect(fs.readFileSync(result.path, 'utf8')).toBe('alice-a')
      for (const asset of [foreign, mixed]) expect(await delivery.adapter.resolveFile!(file(asset))).toMatchObject({ success: false })
      const foreignPath = foreign.filePath
      foreign.filePath = own.filePath
      expect(await delivery.adapter.resolveFile!(file(own))).toMatchObject({ success: false })
      foreign.filePath = foreignPath
      records.delete('alice-a')
      expect(await delivery.adapter.resolveFile!(file(own))).toMatchObject({ success: false })
      expect(await delivery.adapter.resolveFile!('/api/media/file/%2e%2e%2fsecret.png')).toMatchObject({ success: false })
    } finally { delivery.dispose() }
  })

  it('keeps legacy index reads metadata-only and never promotes unknown sources to local imports', async () => {
    const filePath = path.join(dir, 'legacy.png'); fs.writeFileSync(filePath, 'secret')
    fs.writeFileSync(library.storagePaths().indexPath, JSON.stringify({ items: [{ id: 'old', type: 'image', filePath, prompt: 'secret', model: 'm', sessionId: 'missing', messageId: 'm', createdAt: 1 }] }))
    const read = vi.spyOn(fs, 'readFileSync'), write = vi.spyOn(fs, 'writeFileSync')
    expect(await rpc('listAssets')).toEqual({ ok: true, data: [] })
    expect(read.mock.calls.some(call => String(call[0]) === filePath)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
