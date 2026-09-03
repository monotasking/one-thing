import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import { createDefaultVariablesFile } from '@onething/runtime/variables/schema'
import { resetVariablesStoreForTests } from '@onething/runtime/variables/store-bound'
import { getSettings, updateSettingsInMemory } from '../../../stores/settings.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import type {
  MarkdownAssetResolution,
  MarkdownResolveAssetRequest,
  MarkdownSaveAttachmentsRequest,
  MarkdownSaveAttachmentsResponse,
} from '@shared/ipc/markdown.js'
import { markdownRpcHandlers } from '../../../rpc/domains/markdown.js'
import {
  configureHostLocalTrust,
  resetHostLocalTrustForTests,
} from '../../../server/host-trust.js'

/**
 * 主线 T 批 3 之后这两个方法的唯一入口是域 handler。这里用桌面 context 薄封一层,
 * **下面每一条断言一字未改** —— 这正是本文件在这一批要证的事:桌面语义与迁移前
 * 逐字相同。夹紧宿主的行为另有一份 `__tests__/markdown-sandbox.test.ts`。
 *
 * C0 R2:"桌面 = 未夹紧"从前由 `transport:'ipc'` 这个字面量说,现在由宿主的
 * 本机可信声明说(见文件下方 beforeEach) —— context 本身一个字没变。
 */
async function resolveMarkdownAsset(
  request: MarkdownResolveAssetRequest,
): Promise<MarkdownAssetResolution> {
  const response = await markdownRpcHandlers.resolveAsset(request, DESKTOP_RPC_CONTEXT)
  if (!response.success || !response.asset) {
    throw new Error(response.error ?? 'Failed to resolve Markdown asset')
  }
  return response.asset
}

function saveMarkdownAttachments(
  request: MarkdownSaveAttachmentsRequest,
): Promise<MarkdownSaveAttachmentsResponse> {
  return markdownRpcHandlers.saveAttachments(request, DESKTOP_RPC_CONTEXT)
}

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-assets-'))
  tempRoots.push(root)
  return root
}

function configureEditor(editor: Partial<ReturnType<typeof createDefaultSettings>['general']['editor']> = {}): void {
  const settings = createDefaultSettings()
  settings.general.editor = {
    ...settings.general.editor,
    ...editor,
  }
  updateSettingsInMemory(settings)
}

/**
 * 在**当前**设置上改,不从 defaults 重建 —— 否则它和 configureEditor 会互相
 * 抹掉对方(两个测试都要同时配 editor 和接入目录)。
 */
function configureConnectedDirectories(dirs: string[]): void {
  const settings = getSettings()
  updateSettingsInMemory({
    ...settings,
    tools: { ...settings.tools, connectedDirectories: dirs },
  })
}

function fileInput(fileName: string, mimeType = 'image/png') {
  return {
    fileName,
    mimeType,
    base64Data: Buffer.from(`${fileName}:${mimeType}`).toString('base64'),
  }
}

beforeEach(() => {
  configureEditor()
  // C0 R2:桌面 = 宿主声明了本机可信(见文件上方 saveMarkdownAttachments 的说明)。
  configureHostLocalTrust({ origin: 'desktop-embedded' })
  const store = resetVariablesStoreForTests()
  store.hydrateForTests({
    ...createDefaultVariablesFile(),
    user_note_dir: '',
    work_note_dir: '',
  })
})

afterEach(async () => {
  configureEditor()
  resetHostLocalTrustForTests()
  resetVariablesStoreForTests()
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('Markdown asset service', () => {
  it('resolves Obsidian attachment images from the configured attachment folder', async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    const imagePath = path.join(vault, 'attachments', 'image.png')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true })
    await fs.mkdir(path.dirname(imagePath), { recursive: true })
    await fs.writeFile(path.join(vault, '.obsidian', 'app.json'), JSON.stringify({
      attachmentFolderPath: 'attachments',
      useMarkdownLinks: false,
    }))
    await fs.writeFile(notePath, '# Today')
    await fs.writeFile(imagePath, Buffer.from('image'))

    const asset = await resolveMarkdownAsset({
      documentPath: notePath,
      workspaceRoot: vault,
      rawTarget: 'image.png',
    })

    expect(asset).toMatchObject({
      kind: 'image',
      absolutePath: imagePath,
      fileName: 'image.png',
      mimeType: 'image/png',
    })
    expect(asset.dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('resolves Obsidian basename file links through the vault index in large vaults', async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    const attachmentPath = path.join(vault, 'resources', 'sheets', 'IN_Think-Idea_8068857301_VQ_List.xlsx')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.dirname(attachmentPath), { recursive: true })
    await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true })
    await fs.writeFile(path.join(vault, '.obsidian', 'app.json'), JSON.stringify({}))
    await fs.writeFile(notePath, '# Today')
    await fs.writeFile(attachmentPath, 'sheet')

    await Promise.all(Array.from({ length: 5005 }, (_, index) =>
      fs.writeFile(path.join(vault, `filler-${index}.txt`), 'filler'),
    ))

    const asset = await resolveMarkdownAsset({
      documentPath: notePath,
      workspaceRoot: vault,
      rawTarget: 'IN_Think-Idea_8068857301_VQ_List.xlsx',
    })

    expect(asset).toMatchObject({
      kind: 'file',
      absolutePath: attachmentPath,
      fileName: 'IN_Think-Idea_8068857301_VQ_List.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  })

  it('saves Obsidian pasted attachments with wikilinks and unique names', async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true })
    await fs.mkdir(path.join(vault, 'attachments'), { recursive: true })
    await fs.writeFile(path.join(vault, '.obsidian', 'app.json'), JSON.stringify({
      attachmentFolderPath: 'attachments',
      useMarkdownLinks: false,
    }))
    await fs.writeFile(path.join(vault, 'attachments', 'clip.png'), 'existing')

    const result = await saveMarkdownAttachments({
      documentPath: notePath,
      workspaceRoot: vault,
      files: [fileInput('clip.png')],
    })

    expect(result.success).toBe(true)
    expect(result.insertText).toBe('![[attachments/clip-2.png]]')
    expect(result.attachments?.[0]).toMatchObject({
      fileName: 'clip-2.png',
      absolutePath: path.join(vault, 'attachments', 'clip-2.png'),
      linkText: '![[attachments/clip-2.png]]',
    })
    await expect(fs.stat(path.join(vault, 'attachments', 'clip-2.png'))).resolves.toBeTruthy()
  })

  it('requires a configured attachment folder for non-Obsidian note roots', async () => {
    const noteRoot = await makeTempRoot()
    const notePath = path.join(noteRoot, 'personal.md')
    await fs.writeFile(notePath, '# Personal')
    resetVariablesStoreForTests().hydrateForTests({
      ...createDefaultVariablesFile(),
      user_note_dir: noteRoot,
      work_note_dir: '',
    })

    const result = await saveMarkdownAttachments({
      documentPath: notePath,
      workspaceRoot: noteRoot,
      files: [fileInput('receipt.pdf', 'application/pdf')],
    })

    expect(result).toMatchObject({
      success: false,
      code: 'MISSING_NOTE_ATTACHMENT_DIR',
    })
  })

  it('saves non-Obsidian note attachments to the configured note folder', async () => {
    const noteRoot = await makeTempRoot()
    const notePath = path.join(noteRoot, 'personal', 'today.md')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.writeFile(notePath, '# Personal')
    resetVariablesStoreForTests().hydrateForTests({
      ...createDefaultVariablesFile(),
      user_note_dir: noteRoot,
      work_note_dir: '',
    })
    configureEditor({ markdownNoteAttachmentDirectory: 'assets' })

    const result = await saveMarkdownAttachments({
      documentPath: notePath,
      workspaceRoot: noteRoot,
      files: [fileInput('receipt.pdf', 'application/pdf')],
    })

    expect(result.success).toBe(true)
    expect(result.insertText).toBe('[receipt](../assets/receipt.pdf)')
    expect(result.attachments?.[0]?.absolutePath).toBe(path.join(noteRoot, 'assets', 'receipt.pdf'))
  })

  /**
   * 接入目录(五件套之五:markdown 附件根)。判据与笔记根完全同款 ——
   * 一个目录被接入之后,它下面的 .md 写附件时走 note 语义(需要
   * markdownNoteAttachmentDirectory),而不是退回"项目根"那条路。
   */
  describe('connected directories as note roots', () => {
    it('接入目录里的笔记按 note 语义存附件', async () => {
      const connected = await makeTempRoot()
      const notePath = path.join(connected, 'personal', 'today.md')
      await fs.mkdir(path.dirname(notePath), { recursive: true })
      await fs.writeFile(notePath, '# Personal')
      // configureEditor 会从 defaults 重建,所以接入目录必须后写。
      configureEditor({ markdownNoteAttachmentDirectory: 'assets' })
      configureConnectedDirectories([connected])

      const result = await saveMarkdownAttachments({
        documentPath: notePath,
        workspaceRoot: connected,
        files: [fileInput('receipt.pdf', 'application/pdf')],
      })

      expect(result.success).toBe(true)
      expect(result.insertText).toBe('[receipt](../assets/receipt.pdf)')
      expect(result.attachments?.[0]?.absolutePath).toBe(path.join(connected, 'assets', 'receipt.pdf'))
    })

    it('空列表时同一个目录退回项目语义(与没有这个功能时一致)', async () => {
      const plain = await makeTempRoot()
      const notePath = path.join(plain, 'docs', 'readme.md')
      await fs.mkdir(path.dirname(notePath), { recursive: true })
      await fs.writeFile(notePath, '# Project')
      configureConnectedDirectories([])

      const result = await saveMarkdownAttachments({
        documentPath: notePath,
        workspaceRoot: plain,
        files: [fileInput('diagram.png')],
      })

      // 项目语义:不需要 markdownNoteAttachmentDirectory 也能存,落在工作区根下。
      expect(result.success).toBe(true)
      expect(result.attachments?.[0]?.absolutePath).toBe(path.join(plain, 'diagram.png'))
    })
  })

  it('defaults project Markdown attachments to the workspace root', async () => {
    const workspace = await makeTempRoot()
    const notePath = path.join(workspace, 'docs', 'readme.md')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.writeFile(notePath, '# Project')

    const result = await saveMarkdownAttachments({
      documentPath: notePath,
      workspaceRoot: workspace,
      files: [fileInput('diagram.png')],
    })

    expect(result.success).toBe(true)
    expect(result.insertText).toBe('![diagram](../diagram.png)')
    expect(result.attachments?.[0]?.absolutePath).toBe(path.join(workspace, 'diagram.png'))
  })
})
