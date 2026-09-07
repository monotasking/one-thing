import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaLibraryService } from '../library-service-bound.js'
import type { ChatSession, MessageAttachment } from '@shared/ipc.js'

let tempDir: string
let service: MediaLibraryService
let indexPath: string
let imagesDir: string
let filesDir: string

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'att-1',
    fileName: 'upload.png',
    mimeType: 'image/png',
    size: 4,
    mediaType: 'image',
    base64Data: Buffer.from('same-image').toString('base64'),
    ...overrides,
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-library-'))
  imagesDir = path.join(tempDir, 'images')
  filesDir = path.join(tempDir, 'files')
  indexPath = path.join(tempDir, 'index.json')
  fs.mkdirSync(imagesDir, { recursive: true })
  fs.mkdirSync(filesDir, { recursive: true })
  service = new MediaLibraryService({ indexPath, imagesDir, filesDir })
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('MediaLibraryService', () => {
  it('migrates legacy generated image index entries', () => {
    const filePath = path.join(imagesDir, 'legacy.png')
    fs.writeFileSync(filePath, Buffer.from('legacy-image'))
    fs.writeFileSync(indexPath, JSON.stringify({
      items: [{
        id: 'legacy-1',
        type: 'image',
        filePath,
        prompt: 'draw a quiet room',
        revisedPrompt: 'draw a quiet warm room',
        model: 'gpt-image-1',
        createdAt: 123,
        sessionId: 'session-1',
        messageId: 'message-1',
      }],
    }))

    const assets = service.listAssets({ kind: 'image' })

    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({
      id: 'legacy-1',
      kind: 'image',
      source: 'ai-generated',
      filePath,
      metadata: {
        prompt: 'draw a quiet room',
        revisedPrompt: 'draw a quiet warm room',
        model: 'gpt-image-1',
      },
    })
  })

  it('backfills uploaded image attachments and deduplicates by hash', () => {
    const shared = attachment()
    const session = {
      id: 'session-1',
      name: 'Session',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { id: 'message-1', role: 'user', content: '', timestamp: 1, attachments: [shared] },
        { id: 'message-2', role: 'user', content: '', timestamp: 2, attachments: [{ ...shared, id: 'att-2' }] },
      ],
    } as ChatSession

    const result = service.rebuildFromSessions([session])
    const assets = service.listAssets({ kind: 'image', source: 'user-upload' })

    expect(result).toEqual({ added: 1, skipped: 1 })
    expect(assets).toHaveLength(1)
    expect(assets[0].links).toHaveLength(2)
    expect(fs.existsSync(assets[0].filePath!)).toBe(true)
  })

  it('hides assets from the library without deleting stored files', () => {
    const asset = service.ingestAttachment({
      sessionId: 'session-1',
      messageId: 'message-1',
      role: 'user',
      attachment: attachment(),
    })!

    expect(service.hideAsset(asset.id)).toBe(true)

    expect(service.listAssets({ kind: 'image' })).toHaveLength(0)
    expect(service.listAssets({ kind: 'image', includeHidden: true })).toHaveLength(1)
    expect(fs.existsSync(asset.filePath!)).toBe(true)
  })

  it('keeps non-image attachments out of image queries', () => {
    service.ingestAttachment({
      sessionId: 'session-1',
      messageId: 'message-1',
      role: 'user',
      attachment: attachment(),
    })
    service.ingestAttachment({
      sessionId: 'session-1',
      messageId: 'message-1',
      role: 'user',
      attachment: attachment({
        id: 'pdf-1',
        fileName: 'brief.pdf',
        mimeType: 'application/pdf',
        mediaType: 'document',
        base64Data: Buffer.from('pdf').toString('base64'),
      }),
    })

    expect(service.listAssets({ kind: 'image' })).toHaveLength(1)
    expect(service.listAssets({ kind: 'document' })).toHaveLength(1)
  })

  /**
   * A pasted image has no path of its own, yet its bytes are written here on
   * every send. Handing that path back to the attachment is the whole reason
   * the model can now `read` a file the user just pasted.
   */
  describe('ingestMessageAttachments backfills the on-disk path', () => {
    it('gives a pasted attachment the stored copy it now has', () => {
      const pasted = attachment()
      expect(pasted.filePath).toBeUndefined()

      const added = service.ingestMessageAttachments('session-1', 'message-1', 'user', [pasted])

      expect(added).toBe(1)
      expect(pasted.filePath).toBeTruthy()
      expect(path.dirname(pasted.filePath!)).toBe(imagesDir)
      expect(fs.existsSync(pasted.filePath!)).toBe(true)
      expect(fs.readFileSync(pasted.filePath!).toString()).toBe('same-image')
    })

    it('never overwrites the path the user already gave us', () => {
      const dropped = attachment({ filePath: '/Users/me/Desktop/original.png' })

      service.ingestMessageAttachments('session-1', 'message-1', 'user', [dropped])

      expect(dropped.filePath).toBe('/Users/me/Desktop/original.png')
    })

    it('backfills each of several attachments, documents included', () => {
      const image = attachment()
      const doc = attachment({
        id: 'pdf-1',
        fileName: 'brief.pdf',
        mimeType: 'application/pdf',
        mediaType: 'document',
        base64Data: Buffer.from('pdf-bytes').toString('base64'),
      })

      service.ingestMessageAttachments('session-1', 'message-1', 'user', [image, doc])

      expect(path.dirname(image.filePath!)).toBe(imagesDir)
      expect(path.dirname(doc.filePath!)).toBe(filesDir)
      expect(fs.existsSync(doc.filePath!)).toBe(true)
    })

    it('still resolves a path when the bytes dedupe onto an existing asset', () => {
      const first = attachment()
      service.ingestMessageAttachments('session-1', 'message-1', 'user', [first])

      const second = attachment({ id: 'att-2' })
      service.ingestMessageAttachments('session-1', 'message-2', 'user', [second])

      expect(second.filePath).toBe(first.filePath)
      expect(fs.existsSync(second.filePath!)).toBe(true)
    })

    it('leaves an attachment with no bytes alone', () => {
      const empty = attachment({ base64Data: undefined })

      service.ingestMessageAttachments('session-1', 'message-1', 'user', [empty])

      expect(empty.filePath).toBeUndefined()
    })
  })

  /**
   * 任意文件入库(拖放 / 「选择文件」 / web 上传)。这些用例全部在**真实临时
   * 目录**上跑,构造函数收 paths —— 不 mock 路径模块:少写一层的 mock 路径会
   * 静默写穿真实 ~/.onething(2026-07 电台事故的原样复现条件)。
   */
  describe('ingestLocalFiles', () => {
    function sourceFile(name: string, contents: string): string {
      const filePath = path.join(tempDir, name)
      fs.writeFileSync(filePath, Buffer.from(contents))
      return filePath
    }

    it('reads bytes from a path and files them by mime-derived kind', () => {
      const imagePath = sourceFile('shot.png', 'png-bytes')
      const docPath = sourceFile('brief.pdf', 'pdf-bytes')

      const result = service.ingestLocalFiles({
        files: [
          { filePath: imagePath, fileName: 'shot.png' },
          { filePath: docPath, fileName: 'brief.pdf' },
        ],
      })

      expect(result.created).toBe(2)
      expect(result.errors).toEqual([])
      const [image, doc] = result.assets
      expect(image.kind).toBe('image')
      expect(image.mimeType).toBe('image/png')
      expect(path.dirname(image.filePath!)).toBe(imagesDir)
      expect(doc.kind).toBe('document')
      expect(path.dirname(doc.filePath!)).toBe(filesDir)
      expect(fs.readFileSync(doc.filePath!).toString()).toBe('pdf-bytes')
      // 手喂的文件默认就是上传 —— 这是 source 这一维的缺省真相。
      expect(image.source).toBe('user-upload')
      // 没给 links 就是没有来源消息,而不是"链到一个空会话"。
      expect(image.links).toEqual([])
    })

    it('accepts base64 for hosts with no local path, and guesses mime from the name', () => {
      const result = service.ingestLocalFiles({
        files: [{
          base64Data: Buffer.from('browser-bytes').toString('base64'),
          fileName: 'from-web.jpg',
        }],
      })

      expect(result.created).toBe(1)
      expect(result.assets[0].mimeType).toBe('image/jpeg')
      expect(result.assets[0].kind).toBe('image')
      expect(fs.readFileSync(result.assets[0].filePath!).toString()).toBe('browser-bytes')
    })

    it('dedupes within the same source session and merges its message links', () => {
      const filePath = sourceFile('twice.png', 'same-bytes')

      const first = service.ingestLocalFiles({
        files: [{ filePath, fileName: 'twice.png' }],
        links: [{ sessionId: 'session-1', messageId: 'message-1' }],
      })
      const second = service.ingestLocalFiles({
        files: [{ filePath, fileName: 'renamed.png' }],
        links: [{ sessionId: 'session-1', messageId: 'message-2' }],
      })

      expect(first.created).toBe(1)
      expect(second.created).toBe(0)
      expect(second.skipped).toBe(1)
      expect(second.assets[0].id).toBe(first.assets[0].id)
      expect(second.assets[0].links).toEqual([
        { sessionId: 'session-1', messageId: 'message-1' },
        { sessionId: 'session-1', messageId: 'message-2' },
      ])
      expect(service.listAssets()).toHaveLength(1)
    })

    it('keeps a declared source separate from the same bytes uploaded', () => {
      const filePath = sourceFile('shared.png', 'shared-bytes')

      service.ingestLocalFiles({ files: [{ filePath, fileName: 'shared.png' }] })
      const generated = service.ingestLocalFiles({
        files: [{ filePath, fileName: 'shared.png' }],
        source: 'tool-output',
      })

      expect(generated.created).toBe(1)
      expect(generated.assets[0].source).toBe('tool-output')
    })

    it('reports one unreadable file without sinking the rest of the batch', () => {
      const good = sourceFile('good.png', 'good-bytes')

      const result = service.ingestLocalFiles({
        files: [
          { filePath: path.join(tempDir, 'missing.png'), fileName: 'missing.png' },
          { filePath: good, fileName: 'good.png' },
          { fileName: 'no-bytes.png' },
        ],
      })

      expect(result.created).toBe(1)
      expect(result.assets).toHaveLength(1)
      expect(result.errors.map(error => error.fileName)).toEqual(['missing.png', 'no-bytes.png'])
      expect(result.errors[0].error).toContain('File not found')
      expect(result.errors[1].error).toBe('No file data provided')
    })

    it('carries every supplied link onto a newly created asset', () => {
      const filePath = sourceFile('linked.png', 'linked-bytes')

      const result = service.ingestLocalFiles({
        files: [{ filePath, fileName: 'linked.png' }],
        links: [
          { sessionId: 'session-1', messageId: 'message-1' },
          { sessionId: 'session-1', messageId: 'message-2' },
        ],
      })

      expect(result.assets[0].links).toEqual([
        { sessionId: 'session-1', messageId: 'message-1' },
        { sessionId: 'session-1', messageId: 'message-2' },
      ])
    })

    it('persists across a fresh service over the same paths', () => {
      const filePath = sourceFile('persisted.png', 'persisted-bytes')
      service.ingestLocalFiles({ files: [{ filePath, fileName: 'persisted.png' }] })

      const reopened = new MediaLibraryService({ indexPath, imagesDir, filesDir })
      expect(reopened.listAssets()).toHaveLength(1)
      expect(reopened.listAssets()[0].fileName).toBe('persisted.png')
    })
  })

  describe('ingestGeneratedImage source', () => {
    it('defaults to ai-generated but honours a declared source', async () => {
      const generated = await service.ingestGeneratedImage({
        base64: Buffer.from('generated').toString('base64'),
        prompt: 'a quiet room',
        model: 'gpt-image-1',
        sessionId: 'session-1',
        messageId: 'message-1',
      })
      expect(generated.source).toBe('ai-generated')

      // 挑来的头像走的是同一条管子,但它**是**一次上传 —— 这是 2026-08 之前
      // 「上传的头像出现在生成筛选里」那条 wart 的修法。
      const avatar = await service.ingestGeneratedImage({
        base64: Buffer.from('avatar').toString('base64'),
        prompt: 'Agent avatar',
        model: 'user-upload',
        sessionId: '',
        messageId: '',
        source: 'user-upload',
        usageTags: ['persona-avatar'],
      })
      expect(avatar.source).toBe('user-upload')
      expect(avatar.metadata?.usageTags).toEqual(['persona-avatar'])
      expect(service.listAssets({ source: 'user-upload' })).toHaveLength(1)
    })

    // P4-8:provider 报得出真实类型时,后缀与索引里的 mimeType 都按真实类型写。
    it('records the declared media type in the index and in the file extension', async () => {
      const jpeg = await service.ingestGeneratedImage({
        base64: Buffer.from('jpeg-bytes').toString('base64'),
        prompt: 'a jpeg',
        model: 'gemini-3-pro-image',
        sessionId: 'session-1',
        messageId: 'message-1',
        mediaType: 'image/jpeg',
      })
      expect(jpeg.mimeType).toBe('image/jpeg')
      expect(jpeg.filePath?.endsWith('.jpg')).toBe(true)

      const webp = await service.ingestGeneratedImage({
        base64: Buffer.from('webp-bytes').toString('base64'),
        prompt: 'a webp',
        model: 'gemini-3-pro-image',
        sessionId: 'session-1',
        messageId: 'message-1',
        mediaType: 'image/webp',
      })
      expect(webp.mimeType).toBe('image/webp')
      expect(webp.filePath?.endsWith('.webp')).toBe(true)

      // 缺席 / 不是图 = png(旧行为逐字不变)。
      const fallback = await service.ingestGeneratedImage({
        base64: Buffer.from('png-bytes').toString('base64'),
        prompt: 'no declared type',
        model: 'gpt-image-1',
        sessionId: 'session-1',
        messageId: 'message-1',
      })
      expect(fallback.mimeType).toBe('image/png')
      expect(fallback.filePath?.endsWith('.png')).toBe(true)
    })
  })
})
