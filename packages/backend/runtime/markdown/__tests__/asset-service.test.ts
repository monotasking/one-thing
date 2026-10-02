import * as fs from 'node:fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  noteAttachmentRootStaysInside,
  resolveMarkdownAsset as resolveMarkdownAssetRuntime,
  saveMarkdownAttachments as saveMarkdownAttachmentsRuntime,
  type MarkdownResolveAssetRequest,
  type MarkdownSaveAttachmentsRequest,
  type OnethingMarkdownEditorSettings,
} from '../asset-service.js'
import { FolderVault } from '../../notes/folder/vault.js'
import type { NoteLinkKind, NoteVault } from '../../notes/types.js'

const tempRoots: string[] = []
let editorSettings: OnethingMarkdownEditorSettings = {}
let noteRootsForTests: string[] = []
let vaultsForTests: NoteVault[] = []

/**
 * P3:「这份文档归哪个库」是一格适配器。从前这些用例在盘上造 `.obsidian/app.json`,
 * 因为服务自己会往上找它;今天附件落哪 / 链接怎么写 / 按名找哪个文件三件事都问
 * **库自己**,所以这里假的是「有哪几个库」。
 */
const runtimeAdapters = {
  getEditorSettings: () => editorSettings,
  getNoteRoots: () => noteRootsForTests,
  vaultFor: (absolutePath: string) =>
    vaultsForTests.find(vault => absolutePath.startsWith(`${vault.root}${path.sep}`)) ?? null,
}

/** 一台「wikilink 风格」的库:别的都照目录库,链接写 `[[...]]`。 */
class WikilinkVault extends FolderVault {
  override async linkTextFor(target: string, _sourceDoc: string, kind: NoteLinkKind): Promise<string> {
    const relative = path.relative(this.root, path.resolve(target)).split(path.sep).join('/')
    return `${kind === 'embed' ? '!' : ''}[[${relative}]]`
  }
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-assets-'))
  tempRoots.push(root)
  return root
}

function configureEditor(editor: OnethingMarkdownEditorSettings = {}): void {
  editorSettings = { ...editor }
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
  noteRootsForTests = []
  vaultsForTests = []
})

afterEach(async () => {
  configureEditor()
  noteRootsForTests = []
  vaultsForTests = []
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

function resolveMarkdownAsset(request: MarkdownResolveAssetRequest) {
  return resolveMarkdownAssetRuntime(request, runtimeAdapters)
}

function saveMarkdownAttachments(request: MarkdownSaveAttachmentsRequest) {
  return saveMarkdownAttachmentsRuntime(request, runtimeAdapters)
}

describe('Markdown asset service', () => {
  it('decodes reserved percent-escapes in local targets (CleanShot @2x names)', async () => {
    const root = await makeTempRoot()
    const notePath = path.join(root, 'paper.md')
    const imagePath = path.join(root, 'CleanShot 2026-08-15 at 17.40.24@2x-2.png')
    await fs.writeFile(notePath, '# paper')
    await fs.writeFile(imagePath, Buffer.from('image'))

    // 粘贴管线插的是 encodeURI 过的文件名:%20 之外还有保留字 %40(@)——
    // decodeURI 不还原保留字,这个名字曾永远对不上盘上的文件。
    const asset = await resolveMarkdownAsset({
      documentPath: notePath,
      rawTarget: 'CleanShot%202026-08-15%20at%2017.40.24%402x-2.png',
    })

    expect(asset).toMatchObject({ kind: 'image', absolutePath: imagePath })
  })

  it("resolves attachment images through the vault's own by-name lookup", async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    const imagePath = path.join(vault, 'attachments', 'image.png')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.dirname(imagePath), { recursive: true })
    await fs.writeFile(notePath, '# Today')
    await fs.writeFile(imagePath, Buffer.from('image'))
    vaultsForTests = [new WikilinkVault({ root: vault, id: 'v1', attachmentDirectory: 'attachments' })]

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
   * P3 之前这条用例钉的是「服务自己那份 vault 索引」的 5000 条截断。那份索引删了
   * —— 按名解析今天是库自己的 `resolveByName`(它有自己的单测,含 TTL 与条目上限)。
   * 这里留下的是这条链路仍然通:一个既不在文档同目录、也不在库根的文件,只给
   * basename 也找得到。
   */
  it('resolves a deep attachment by basename through the vault', async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    const attachmentPath = path.join(vault, 'resources', 'sheets', 'IN_Think-Idea_8068857301_VQ_List.xlsx')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.dirname(attachmentPath), { recursive: true })
    await fs.writeFile(notePath, '# Today')
    await fs.writeFile(attachmentPath, 'sheet')
    vaultsForTests = [new WikilinkVault({ root: vault, id: 'v1' })]

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
   * 落点与链接文本**都由库答**(P3)。同名让路那一步也归了库,所以让出来的名字
   * 是库的规则(`clip 1.png`),不再是本服务从前那套 `clip-2.png` —— 两套让名
   * 规则会让同一张图在两条路下落成两个文件。
   */
  it("saves pasted attachments where the vault says, with the vault's link text", async () => {
    const vault = await makeTempRoot()
    const notePath = path.join(vault, 'notes', 'today.md')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.mkdir(path.join(vault, 'attachments'), { recursive: true })
    await fs.writeFile(path.join(vault, 'attachments', 'clip.png'), 'existing')
    vaultsForTests = [new WikilinkVault({ root: vault, id: 'v1', attachmentDirectory: 'attachments' })]

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
   * 沙箱守卫的**判法**(装配层的调用点在 `wiring/markdown/asset-service.ts`)。
   *
   * 它问的是「库会把附件放哪」,与真正写入用的是同一个答案 —— 从前那是两份实现
   * (守卫自己读一遍 `app.json`),两份实现就会各说各话。
   */
  describe('noteAttachmentRootStaysInside', () => {
    it('库把附件指到界外 = 拒;指在界内 = 放行;没有库 = 恒放行', async () => {
      const boundary = await makeTempRoot()
      const outside = await makeTempRoot()
      const vaultRoot = path.join(boundary, 'vault')
      const notePath = path.join(vaultRoot, 'today.md')
      await fs.mkdir(vaultRoot, { recursive: true })

      const escaping = {
        ...runtimeAdapters,
        vaultFor: () => new FolderVault({
          root: vaultRoot,
          id: 'v-out',
          // 附件目录是**库相对**的,指到界外要写成 `../..` 这样的相对路径。
          attachmentDirectory: path.relative(vaultRoot, outside),
        }),
      }
      await expect(noteAttachmentRootStaysInside(notePath, boundary, escaping)).resolves.toBe(false)

      const inside = {
        ...runtimeAdapters,
        vaultFor: () => new FolderVault({ root: vaultRoot, id: 'v-in', attachmentDirectory: 'attachments' }),
      }
      await expect(noteAttachmentRootStaysInside(notePath, boundary, inside)).resolves.toBe(true)

      // 一个库都不认领 = 没有库的配置可逃。夹紧的宿主正是这一档。
      await expect(noteAttachmentRootStaysInside(notePath, boundary, runtimeAdapters)).resolves.toBe(true)
    })
  })

  it('requires a configured attachment folder for a note root no vault claims', async () => {
    const noteRoot = await makeTempRoot()
    const notePath = path.join(noteRoot, 'personal.md')
    await fs.writeFile(notePath, '# Personal')
    noteRootsForTests = [noteRoot]

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
    noteRootsForTests = [noteRoot]
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
