import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnethingMediaLibraryService } from '../media-library-service.js'

let tempDir: string
let service: OnethingMediaLibraryService
let indexPath: string
let imagesDir: string
let filesDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-media-'))
  imagesDir = path.join(tempDir, 'images')
  filesDir = path.join(tempDir, 'files')
  indexPath = path.join(tempDir, 'index.json')
  fs.mkdirSync(imagesDir, { recursive: true })
  fs.mkdirSync(filesDir, { recursive: true })
  service = new OnethingMediaLibraryService({ indexPath, imagesDir, filesDir })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('OnethingMediaLibraryService', () => {
  it('projects legacy image items and skips missing files', async () => {
    const existingFilePath = path.join(imagesDir, 'existing.png')
    const missingFilePath = path.join(imagesDir, 'missing.png')
    fs.writeFileSync(existingFilePath, Buffer.from('existing-image'))

    fs.writeFileSync(indexPath, JSON.stringify({
      version: 2,
      assets: [
        {
          id: 'missing-image',
          kind: 'image',
          source: 'ai-generated',
          mimeType: 'image/png',
          size: 12,
          fileName: 'missing.png',
          filePath: missingFilePath,
          links: [{ sessionId: 'session-2', messageId: 'message-2', role: 'assistant' }],
          metadata: { prompt: 'missing prompt', model: 'gpt-image-1' },
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: 'existing-image',
          kind: 'image',
          source: 'ai-generated',
          mimeType: 'image/png',
          size: 14,
          fileName: 'existing.png',
          filePath: existingFilePath,
          links: [{ sessionId: 'session-1', messageId: 'message-1', role: 'assistant' }],
          metadata: {
            prompt: 'draw an existing image',
            revisedPrompt: 'draw an existing image with warm light',
            model: 'gpt-image-1',
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }))

    expect(service.listLegacyImages()).toEqual([
      {
        id: 'existing-image',
        type: 'image',
        filePath: existingFilePath,
        prompt: 'draw an existing image',
        revisedPrompt: 'draw an existing image with warm light',
        model: 'gpt-image-1',
        createdAt: 1,
        sessionId: 'session-1',
        messageId: 'message-1',
      },
    ])
  })

  it('saves generated images as legacy media items', async () => {
    const item = await service.saveGeneratedImageAsLegacyItem({
      base64: Buffer.from('generated-image').toString('base64'),
      prompt: 'draw a bright desk',
      revisedPrompt: 'draw a bright desk near a window',
      model: 'gpt-image-1',
      sessionId: 'session-3',
      messageId: 'message-3',
    })

    expect(item).toMatchObject({
      type: 'image',
      prompt: 'draw a bright desk',
      revisedPrompt: 'draw a bright desk near a window',
      model: 'gpt-image-1',
      sessionId: 'session-3',
      messageId: 'message-3',
    })
    expect(fs.existsSync(item.filePath)).toBe(true)
  })

  it('rebuilds from message attachments with a single index write', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync')

    const result = service.rebuildFromSessions([
      {
        id: 'session-1',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            attachments: [
              {
                id: 'attachment-1',
                fileName: 'notes.pdf',
                mimeType: 'application/pdf',
                mediaType: 'document',
                size: 128,
              },
              {
                id: 'attachment-2',
                fileName: 'clip.mp4',
                mimeType: 'video/mp4',
                mediaType: 'video',
                size: 256,
              },
            ],
          },
        ],
      },
    ])

    const indexWrites = writeSpy.mock.calls.filter(call => /\.index\.json\.[^/]*\.tmp$/.test(String(call[0])))
    expect(result).toEqual({ added: 2, skipped: 0 })
    expect(indexWrites).toHaveLength(1)

    writeSpy.mockClear()
    expect(service.rebuildFromSessions([
      {
        id: 'session-1',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            attachments: [
              {
                id: 'attachment-1',
                fileName: 'notes.pdf',
                mimeType: 'application/pdf',
                mediaType: 'document',
                size: 128,
              },
              {
                id: 'attachment-2',
                fileName: 'clip.mp4',
                mimeType: 'video/mp4',
                mediaType: 'video',
                size: 256,
              },
            ],
          },
        ],
      },
    ])).toEqual({ added: 0, skipped: 2 })
    expect(writeSpy.mock.calls.filter(call => /\.index\.json\.[^/]*\.tmp$/.test(String(call[0])))).toHaveLength(0)

    writeSpy.mockRestore()
  })
})
