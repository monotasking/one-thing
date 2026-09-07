import * as fs from 'node:fs/promises'
import type { Dirent, PathLike } from 'node:fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveMarkdownAsset as resolveMarkdownAssetRuntime,
  saveMarkdownAttachments as saveMarkdownAttachmentsRuntime,
  type MarkdownResolveAssetRequest,
  type MarkdownAssetResolution,
  type MarkdownSaveAttachmentsRequest,
  type OnethingMarkdownEditorSettings,
} from '../asset-service.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

const tempRoots: string[] = []
let editorSettings: OnethingMarkdownEditorSettings = {}
let noteRootsForTests: string[] = []

const runtimeAdapters = {
  getEditorSettings: () => editorSettings,
  getNoteRoots: () => noteRootsForTests,
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
})

afterEach(async () => {
  configureEditor()
  noteRootsForTests = []
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

    // Exercise the old 5000-entry cutoff without thousands of unrelated writes
    // competing with the full suite. The vault, config and target remain real.
    const [fileEntry] = await fs.readdir(path.dirname(notePath), { withFileTypes: true })
    const fillerEntries = Array.from({ length: 5005 }, (_, index) => new Proxy(fileEntry, {
      get: (entry, property, receiver) => property === 'name'
        ? `filler-${index}.txt`
        : Reflect.get(entry, property, receiver),
    }))
    const { readdir: readDirectory } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let indexedEntryCount = 0
    const directoryRead = vi.spyOn(fs, 'readdir').mockImplementation((async (directory: PathLike, ...options: unknown[]) => {
      const entries = await Reflect.apply(readDirectory, fs, [directory, ...options])
      if (directory !== vault || !(options[0] as { withFileTypes?: boolean })?.withFileTypes) return entries
      const wideDirectory: Dirent[] = [...fillerEntries, ...entries]
      indexedEntryCount = wideDirectory.length
      return wideDirectory
    }) as typeof fs.readdir)
    let asset: MarkdownAssetResolution
    try {
      asset = await resolveMarkdownAsset({
        documentPath: notePath,
        workspaceRoot: vault,
        rawTarget: 'IN_Think-Idea_8068857301_VQ_List.xlsx',
      })
    } finally {
      directoryRead.mockRestore()
    }

    expect(indexedEntryCount).toBeGreaterThan(5000)
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

  it('saves non-Obsidian note attachments to the configured note folder', async () => {
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
