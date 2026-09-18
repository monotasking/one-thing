import * as fs from 'node:fs/promises'
import type { Dirent, PathLike } from 'node:fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { FolderVault } from '@onething/runtime/notes'
import type { NoteLinkKind, NoteVault } from '@onething/runtime/notes'

/**
 * 笔记领域的假件(P3)。
 *
 * 从前这些用例在临时目录里造一个 `.obsidian/app.json`,因为服务自己会往上找它。
 * 今天服务问的是**注册表**:一条路径归哪个库、附件落哪、链接怎么写,三件事都由
 * 库自己答。所以这里假的是「有哪几个库」,盘上一个 `.obsidian` 都不需要。
 *
 * 反证:把 `markdownRuntimeAdapters` 的 `vaultFor` 挖掉,下面每一条 vault 用例
 * 都会退回项目语义(附件落工作区根、链接写标准 md),当场红。
 */
const notes = vi.hoisted(() => ({ vaults: [] as NoteVault[], roots: [] as string[] }))
vi.mock('../../notes/index.js', () => ({
  getNotesSubsystemSafe: () => ({
    registry: {
      vaultFor: (absolutePath: string) =>
        notes.vaults.find(vault => absolutePath.startsWith(`${vault.root}${path.sep}`)) ?? null,
    },
  }),
  // 根表与库表分成两格,正是为了测得着「在笔记根里但没有库认领」那一态
  // (桌面上两者同源,夹紧的宿主让它们不同源)。
  noteRootsNow: () => notes.roots,
}))

/** 一台「wikilink 风格」的库:别的都照目录库,链接写 `[[...]]`。 */
class WikilinkVault extends FolderVault {
  override async linkTextFor(target: string, _sourceDoc: string, kind: NoteLinkKind): Promise<string> {
    const relative = path.relative(this.root, path.resolve(target)).split(path.sep).join('/')
    return `${kind === 'embed' ? '!' : ''}[[${relative}]]`
  }
}

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

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
 * 「没有库认领的笔记根」那一态的附件目录。P3 起它只有一格
 * `settings.notes.attachmentDirectory`(老的 `editor.markdownNoteAttachmentDirectory`
 * 已删)。在**当前**设置上改,理由同下面那只。
 */
function configureNoteAttachmentDirectory(value: string): void {
  const settings = getSettings()
  updateSettingsInMemory({
    ...settings,
    notes: { ...settings.notes!, attachmentDirectory: value },
  })
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
  notes.vaults = []
  notes.roots = []
  configureEditor()
  // C0 R2:桌面 = 宿主声明了本机可信(见文件上方 saveMarkdownAttachments 的说明)。
  configureHostLocalTrust({ origin: 'desktop-embedded' })
  resetVariablesStoreForTests().hydrateForTests(createDefaultVariablesFile())
})

afterEach(async () => {
  configureEditor()
  resetHostLocalTrustForTests()
  resetVariablesStoreForTests()
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('Markdown asset service', () => {
  it('resolves note-vault attachment images from the vault\'s attachment folder', async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    const imagePath = path.join(vault, 'attachments', 'image.png')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.dirname(imagePath), { recursive: true })
    await fs.writeFile(notePath, '# Today')
    await fs.writeFile(imagePath, Buffer.from('image'))
    notes.vaults = [new WikilinkVault({ root: vault, id: 'v1', attachmentDirectory: 'attachments' })]

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

  /**
   * 按 basename 找一个埋在深处的附件。
   *
   * P3 之前这条用例还在钉「服务自己那份 vault 索引」的 5000 条截断(它拿 5005 个
   * 假 Dirent 撑宽一层目录)。那份索引删了 —— 按名解析今天是**库自己**的
   * `resolveByName`,它有自己的单测。这里留下的是这条链路仍然通:一个既不在文档
   * 同目录、也不在库根的文件,只给 basename 也找得到。
   */
  it('resolves a deep attachment by basename through the vault', async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    const attachmentPath = path.join(vault, 'resources', 'sheets', 'IN_Think-Idea_8068857301_VQ_List.xlsx')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.dirname(attachmentPath), { recursive: true })
    await fs.writeFile(notePath, '# Today')
    await fs.writeFile(attachmentPath, 'sheet')
    notes.vaults = [new WikilinkVault({ root: vault, id: 'v1' })]

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

  /**
   * 落点与链接文本**都由库答**(P3)。
   *
   * 连带的行为变化:同名让路那一步也归了库,所以让出来的名字是库的规则
   * (`clip 1.png`),不再是本服务从前那套 `clip-2.png`。这正是「两套让名规则会
   * 让同一张图在两条路下落成两个文件」要消掉的东西。
   */
  it('saves pasted attachments where the vault says, with the vault\'s link text', async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.join(vault, 'attachments'), { recursive: true })
    await fs.writeFile(path.join(vault, 'attachments', 'clip.png'), 'existing')
    notes.vaults = [new WikilinkVault({ root: vault, id: 'v1', attachmentDirectory: 'attachments' })]

    const result = await saveMarkdownAttachments({
      documentPath: notePath,
      workspaceRoot: vault,
      files: [fileInput('clip.png')],
    })

    expect(result.success).toBe(true)
    expect(result.insertText).toBe('![[attachments/clip 1.png]]')
    expect(result.attachments?.[0]).toMatchObject({
      fileName: 'clip 1.png',
      absolutePath: path.join(vault, 'attachments', 'clip 1.png'),
      linkText: '![[attachments/clip 1.png]]',
    })
    await expect(fs.stat(path.join(vault, 'attachments', 'clip 1.png'))).resolves.toBeTruthy()
  })

  /**
   * 「在笔记根里,但没有库认领」那一态。P1 之后用户加的目录本身就是库,所以这一态
   * 在桌面上实际是空集 —— 它仍然测得着,因为根列表与库表是两个端口
   * (`getNoteRoots` / `vaultFor`),夹紧的宿主就让它们不同源。
   */
  it('requires a configured attachment folder for a note root no vault claims', async () => {
    const noteRoot = await makeTempRoot()
    const notePath = path.join(noteRoot, 'personal.md')
    await fs.writeFile(notePath, '# Personal')
    notes.roots = [noteRoot]

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

  it('saves unclaimed note-root attachments to the configured note folder', async () => {
    const noteRoot = await makeTempRoot()
    const notePath = path.join(noteRoot, 'personal', 'today.md')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.writeFile(notePath, '# Personal')
    notes.roots = [noteRoot]
    configureNoteAttachmentDirectory('assets')

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
   * **接入目录不再是笔记根**(P3,正本 §4.5)。
   *
   * 从前一个目录被「接入」之后,它下面的 .md 写附件走 note 语义。今天「哪些目录
   * 算笔记」只有一句话 —— 在册的笔记库;接入目录是**权限面**(用户临时开给某间
   * 会话看的目录),两件事不该混在一句话里。用户真想让某个目录算笔记,就在设置的
   * 「其他笔记目录」里加它,那时它是一个货真价实的库。
   */
  describe('connected directories are no longer note roots', () => {
    it('只被接入的目录退回项目语义(附件落工作区根,不需要笔记附件目录)', async () => {
      const connected = await makeTempRoot()
      const notePath = path.join(connected, 'personal', 'today.md')
      await fs.mkdir(path.dirname(notePath), { recursive: true })
      await fs.writeFile(notePath, '# Personal')
      configureConnectedDirectories([connected])
      configureNoteAttachmentDirectory('assets')

      const result = await saveMarkdownAttachments({
        documentPath: notePath,
        workspaceRoot: connected,
        files: [fileInput('receipt.pdf', 'application/pdf')],
      })

      expect(result.success).toBe(true)
      expect(result.attachments?.[0]?.absolutePath).toBe(path.join(connected, 'receipt.pdf'))
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

      // 项目语义:不需要笔记附件目录也能存,落在工作区根下。
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
