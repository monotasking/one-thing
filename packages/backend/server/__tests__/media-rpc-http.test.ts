import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOnethingHttpServer } from '../http.js'
import { createAppServerRuntime } from './test-helpers.js'
import type { OnethingServerRuntime } from '../runtime.js'

let dir: string
let runtime: OnethingServerRuntime | undefined
const servers: Server[] = []
const previousStore = process.env.ONETHING_STORE_PATH
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-http-access-'))
  process.env.ONETHING_STORE_PATH = dir
})
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  await runtime?.shutdown(); runtime = undefined
  if (previousStore === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStore
  fs.rmSync(dir, { recursive: true, force: true })
})

it('uses one real Backend library for authenticated RPC uploads, gallery and HTTP bytes', async () => {
  runtime = await createAppServerRuntime({ storePath: dir, dataRoot: dir })
  async function listener(user: string) {
    const server = createOnethingHttpServer({ runtime: runtime!.runtime, authToken: 'media-secret', defaultUserId: user, allowedWorkspaceIds: ['default', 'a', 'b'] })
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  const alice = await listener('alice'), bob = await listener('bob')
  const headers = { authorization: 'Bearer media-secret', 'content-type': 'application/json', 'x-onething-workspace-id': 'a' }
  async function rpc(origin: string, method: string, payload: unknown, extra: Record<string, string> = {}) {
    return (await fetch(`${origin}/api/rpc`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ domain: 'media', method, payload }) })).json()
  }
  const sessionResponse = await fetch(`${alice}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ name: 'Alice media source' }) })
  const source = await sessionResponse.json() as { session: { id: string } }
  const uploaded = await rpc(alice, 'ingestFiles', { files: [{ fileName: 'upload.png', base64Data: 'YWxpY2UtaW1hZ2U=' }], links: [{ sessionId: source.session.id }] })
  expect(uploaded).toMatchObject({ ok: true, data: { created: 1 } })
  const asset = uploaded.data.assets[0] as { id: string; filePath: string }
  const url = `/api/media/file/${path.basename(asset.filePath)}`
  const ownBytes = await fetch(`${alice}${url}`, { headers })
  expect(ownBytes.status).toBe(200); expect(await ownBytes.text()).toBe('alice-image')
  expect((await fetch(`${bob}${url}`, { headers })).status).toBe(404)
  expect((await fetch(`${alice}${url}`, { headers: { ...headers, 'x-onething-workspace-id': 'b' } })).status).toBe(404)
  expect(await rpc(bob, 'readImageBase64', { filePath: asset.filePath })).toMatchObject({ ok: false })
  expect(await rpc(bob, 'getGallery', { assetId: asset.id })).toMatchObject({ ok: false })
  expect(await rpc(bob, 'hideAsset', { id: asset.id })).toMatchObject({ ok: false })
  expect(await rpc(alice, 'listAssets', {})).toMatchObject({ ok: true, data: [{ id: asset.id }] })
  expect(await rpc(bob, 'listAssets', {})).toEqual({ ok: true, data: [] })
})

it('holds the actual Backend open while media I/O drains and rejects old references after reassembly', async () => {
  runtime = await createAppServerRuntime({ storePath: dir, dataRoot: dir })
  const library = runtime.backend!.mediaLibrary
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const receiving = new Promise<void>(resolve => { started = resolve })
  const download = createServer(async (_request, response) => { started(); await gate; response.end('late') })
  servers.push(download); download.listen(0, '127.0.0.1'); await once(download, 'listening')
  const oldWrite = library.ingestGeneratedImage.bind(library)
  const input = { sessionId: 'internal', messageId: 'm', prompt: 'image', model: 'image' }
  const outcome = oldWrite({ ...input, url: `http://127.0.0.1:${(download.address() as { port: number }).port}/image` }).then(() => undefined, error => error)
  await receiving
  let settled = false
  const closing = runtime.shutdown().then(() => { settled = true })
  try {
    await vi.waitFor(() => expect(() => library.listAssets()).toThrow('stopped'))
    expect(settled).toBe(false)
    // The server host takes no store mutex (2026-08-24 ruling), so the drain is
    // observed on the Backend itself rather than on a lock file.
    expect(runtime!.backend!.ownedLabels().length).toBeGreaterThan(0)
  } finally { release() }
  expect(await outcome).toMatchObject({ message: 'Media library has been stopped' })
  await closing
  expect(runtime!.backend!.ownedLabels()).toEqual([])
  const second = path.join(dir, 'second-store')
  process.env.ONETHING_STORE_PATH = second
  runtime = await createAppServerRuntime({ storePath: second, dataRoot: second })
  await expect(oldWrite({ ...input, base64: 'b2xk' })).rejects.toThrow('stopped')
  await runtime.backend!.mediaLibrary.ingestGeneratedImage({ ...input, base64: 'bmV3' })
  const newAssets = runtime.backend!.mediaLibrary.listAssets()
  expect(newAssets).toHaveLength(1)
  expect(fs.readFileSync(newAssets[0].filePath!, 'utf8')).toBe('new')
})
