import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { OnethingBackend } from '../backend.js'

it('serves restored media after offline original-path activation', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-backup-activation-'))
  const original = path.join(root, 'store')
  const staging = path.join(root, 'staging')
  const backup = path.join(root, 'backup')
  const preserved = path.join(root, 'preserved-original')
  const previous = process.env.ONETHING_STORE_PATH
  let backend: OnethingBackend | undefined
  try {
    process.env.ONETHING_STORE_PATH = original
    const { createOnethingBackend } = await import('../backend.js')
    const { createStoreBackup, restoreStoreBackup, STORE_RESTORE_PENDING } = await import('@onething/runtime/storage')
    const { createServerMediaDelivery } = await import('../server/media-delivery.js')
    const assemble = (storePath: string, afterSettings = () => {}) => createOnethingBackend({
      storePath, toolRegistry: 'headless', hooks: { afterSettings },
      host: {
        storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
        terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
        gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null,
      },
    })
    backend = await assemble(original)
    const bytes = Buffer.from('original-media-bytes')
    const owner = { userId: 'local-user', workspaceId: 'default' }
    const imported = backend.mediaLibrary.ingestLocalFiles({ files: [{ fileName: 'image.png', mimeType: 'image/png', base64Data: bytes.toString('base64') }] }, owner)
    expect(imported.errors).toEqual([])
    const asset = imported.assets[0]!
    expect(path.isAbsolute(asset.filePath!)).toBe(true)
    const mediaRelative = path.relative(fs.realpathSync(original), asset.filePath!)
    await backend.dispose()
    backend = undefined
    await createStoreBackup({ storePath: original, backupPath: backup })
    await restoreStoreBackup({ backupPath: backup, storePath: staging })
    // 2026-09-07:`store-format.json` 单向能力门整条撤回,启动侧不再拒绝暂存路径;
    // 留在暂存目录里的完成标记仍然写着「回原址激活」这条约束(见 store-backup.ts)。
    expect(JSON.parse(fs.readFileSync(path.join(staging, STORE_RESTORE_PENDING), 'utf8')))
      .toMatchObject({ version: 1, state: 'complete', activationStorePath: fs.realpathSync(original) })
    // All fixture hosts are stopped. Preserve the original, then return the
    // verified whole tree to its original location without rewriting the index.
    fs.renameSync(original, preserved)
    fs.renameSync(staging, original)
    fs.writeFileSync(path.join(preserved, mediaRelative), 'different-preserved-copy')
    process.env.ONETHING_STORE_PATH = original
    backend = await assemble(original)
    expect(backend.mediaLibrary.getAsset(asset.id)?.filePath).toBe(asset.filePath)
    const delivery = createServerMediaDelivery({
      defaultContext: () => owner, ownerKey: () => 'local',
      libraryPaths: () => backend!.mediaLibrary.storagePaths(),
      access: backend.sessionLayer.access, sharedLibrary: backend.mediaLibrary,
    })
    try {
      const file = await delivery.adapter.resolveFile!(`media://${path.basename(asset.filePath!)}`, owner)
      expect(file.success).toBe(true)
      expect(fs.readFileSync(file.path!)).toEqual(bytes)
      expect(file.mimeType).toBe('image/png')
    } finally { delivery.dispose() }
  } finally {
    try { await backend?.dispose() }
    finally {
      if (previous === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})
