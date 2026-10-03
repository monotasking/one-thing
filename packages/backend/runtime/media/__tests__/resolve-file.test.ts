/**
 * `resolveMediaFileByName` —— 「按文件名找媒体库文件」全仓唯一那份判据(G 线 §23.2)。
 * 三条拒绝(越界路径 / 无权 / 不存在)各钉一条,外加一道静态门:HTTP 那条路
 * (`server/media-delivery.ts`)与 RPC 那条路(`rpc/domains/media.ts`)都调它,且 HTTP 那边
 * 不再自己做 basename 匹配 —— 判据抄回去一份,两边迟早各说各话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OnethingMediaLibraryService, type OnethingMediaAsset } from '@onething/backend/runtime/media'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { createSessionAccess } from '@onething/backend/runtime/sessions'
import { mediaFileNameOf, resolveMediaFileByName } from '../resolve-file.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(here, '../../..')

describe('resolveMediaFileByName', () => {
  let dir: string
  let library: OnethingMediaLibraryService
  const records = new Map<string, { id: string; ownerUserId?: string; ownerWorkspaceId?: string }>()
  const access = createSessionAccess({ findMeta: id => records.get(id) })
  const alice: RpcDispatchContext = { transport: 'http', ownerUid: 'alice', workspaceId: 'a' }
  const name = (asset: OnethingMediaAsset) => path.basename(asset.filePath!)
  async function image(sessionId: string, bytes = sessionId) {
    return library.ingestGeneratedImage({ sessionId, messageId: `${sessionId}-m`, base64: Buffer.from(bytes).toString('base64'), prompt: 'p', model: 'm' })
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-resolve-'))
    library = new OnethingMediaLibraryService({ indexPath: path.join(dir, 'index.json'), imagesDir: path.join(dir, 'images'), filesDir: path.join(dir, 'files') })
    records.clear()
    records.set('alice-a', { id: 'alice-a', ownerUserId: 'alice', ownerWorkspaceId: 'a' })
    records.set('bob-a', { id: 'bob-a', ownerUserId: 'bob', ownerWorkspaceId: 'a' })
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('finds an own asset by bare name, media:// and /api/media/file/ alike', async () => {
    const own = await image('alice-a')
    const expected = { path: fs.realpathSync(own.filePath!), mimeType: 'image/png' }
    for (const input of [name(own), `media://${name(own)}`, `/api/media/file/${encodeURIComponent(name(own))}`]) {
      expect(resolveMediaFileByName([library], access, alice, input)).toEqual(expected)
    }
  })

  it('refuses a path smuggled into the name (越界路径)', async () => {
    const own = await image('alice-a')
    expect(resolveMediaFileByName([library], access, alice, `media://${encodeURIComponent(`../images/${name(own)}`)}`)).toBeUndefined()
    expect(resolveMediaFileByName([library], access, alice, '/api/media/file/%2e%2e%2fsecret.png')).toBeUndefined()
    expect(mediaFileNameOf('media://%E0%A4%A')).toBeUndefined() // 解码失败
    expect(mediaFileNameOf('..')).toBeUndefined()
    // 资产表被改成指向库根外:哪怕名字对得上也不给。
    const tampered = await image('alice-a', 'tampered')
    const tamperedName = name(tampered)
    fs.renameSync(tampered.filePath!, path.join(dir, tamperedName))
    tampered.filePath = path.join(dir, tamperedName)
    expect(resolveMediaFileByName([library], access, alice, tamperedName)).toBeUndefined()
  })

  it('refuses a foreign asset, and a shared name when any one of its owners is foreign (无权)', async () => {
    const foreign = await image('bob-a')
    expect(resolveMediaFileByName([library], access, alice, name(foreign))).toBeUndefined()
    const mixed = await image('alice-a', 'mixed')
    mixed.links.push({ sessionId: 'bob-a' })
    expect(resolveMediaFileByName([library], access, alice, name(mixed))).toBeUndefined()
  })

  it('answers undefined for a name the table does not hold (不存在)', () => {
    expect(resolveMediaFileByName([library], access, alice, 'missing.png')).toBeUndefined()
    expect(resolveMediaFileByName([], access, alice, 'missing.png')).toBeUndefined()
  })

  it('is the one judgment both HTTP and RPC call (静态门)', () => {
    const delivery = fs.readFileSync(path.join(backendRoot, 'server/media-delivery.ts'), 'utf8')
    const domain = fs.readFileSync(path.join(backendRoot, 'rpc/domains/media.ts'), 'utf8')
    expect(delivery).toContain('resolveMediaFileByName(')
    expect(domain).toContain('resolveMediaFileByName(')
    // HTTP 那边不再自己做 basename 匹配 / 根判定:那段只许住在 resolve-file.ts。
    expect(delivery).not.toMatch(/\bbasename\b/)
    expect(delivery).not.toMatch(/imagesDir|filesDir/)
    expect(delivery).not.toMatch(/assertMediaAccess/)
  })
})
