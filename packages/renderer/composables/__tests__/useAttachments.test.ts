// @vitest-environment happy-dom
import { reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttachments } from '../useAttachments'

const mocks = vi.hoisted(() => ({
  settingsStore: null as any,
  getPathForFile: null as any,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => mocks.settingsStore,
}))

// 能力判定改走 useActiveModelCapabilities(与发送同源的那条解析链)之后,它会
// 顺带碰到 sessions / agents 两个 store。这里给的是"没有会话、没有 agent"的
// 空壳 —— 于是解析退回全局那一档,正是这些用例一直在测的情形。
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({ getSessionItem: () => null }),
}))

vi.mock('@/stores/agents', () => ({
  useAgentsStore: () => ({ getAgent: () => null }),
}))

vi.mock('@/platform', () => ({
  platformApi: {
    getPathForFile: (file: File) => mocks.getPathForFile(file),
  },
}))

/** Only dropped/picked files carry an on-disk path; pasted blobs never do. */
function withDiskPath(file: File, path: string) {
  mocks.getPathForFile = (candidate: File) => (candidate === file ? path : '')
  return file
}

function makePasteEvent(files: File[]): ClipboardEvent {
  return {
    clipboardData: {
      files,
      items: files.map(file => ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      })),
    },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent
}

describe('useAttachments', () => {
  beforeEach(() => {
    mocks.getPathForFile = () => ''
    mocks.settingsStore = reactive({
      settings: {
        ai: {
          provider: 'openai',
          providers: {
            openai: { model: 'gpt-vision' },
          },
        },
      },
      getCachedModels: vi.fn(() => [{
        id: 'gpt-vision',
        architecture: { input_modalities: ['text', 'image'] },
      }]),
    })

    vi.stubGlobal('Image', class {
      width = 640
      height = 480
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not intercept plain text paste events', async () => {
    const attachments = useAttachments()
    const event = {
      clipboardData: { files: [], items: [] },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent

    const result = await attachments.handlePaste(event)

    expect(result.handled).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(attachments.attachedFiles.value).toEqual([])
  })

  it('creates image attachments with preview and dimensions from clipboard files', async () => {
    const attachments = useAttachments()
    const file = new File(['image-bytes'], 'screenshot.png', { type: 'image/png' })
    const event = makePasteEvent([file])

    const result = await attachments.handlePaste(event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
    expect(attachments.attachedFiles.value[0]).toMatchObject({
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      size: file.size,
      mediaType: 'image',
      width: 640,
      height: 480,
    })
    expect(attachments.attachedFiles.value[0].preview).toMatch(/^data:image\/png;base64,/)
    expect(attachments.toMessageAttachments()?.[0].base64Data).toBeTruthy()
  })

  it('creates document/file attachments for non-image clipboard files', async () => {
    const attachments = useAttachments()
    const file = new File(['pdf-bytes'], 'brief.pdf', { type: 'application/pdf' })
    const event = makePasteEvent([file])

    const result = await attachments.handlePaste(event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(result.accepted).toHaveLength(1)
    expect(attachments.attachedFiles.value[0]).toMatchObject({
      fileName: 'brief.pdf',
      mimeType: 'application/pdf',
      mediaType: 'document',
    })
  })

  it('rejects files larger than the attachment size limit', async () => {
    const attachments = useAttachments()
    const file = new File(['x'], 'huge.bin', { type: 'application/octet-stream' })
    Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 })
    const event = makePasteEvent([file])

    const result = await attachments.handlePaste(event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]).toMatchObject({
      fileName: 'huge.bin',
      reason: 'too-large',
    })
    expect(attachments.attachedFiles.value).toEqual([])
  })

  it('carries the on-disk path through to the outgoing attachment', async () => {
    const attachments = useAttachments()
    const file = withDiskPath(
      new File(['image-bytes'], 'shot.png', { type: 'image/png' }),
      '/Users/me/shot.png',
    )

    await attachments.processFiles([file])

    expect(attachments.attachedFiles.value[0].filePath).toBe('/Users/me/shot.png')
    // The engine's last-resort fallback tells the model to read this path, so
    // it has to survive the hand-off to the send-message command.
    expect(attachments.toMessageAttachments()?.[0].filePath).toBe('/Users/me/shot.png')
  })

  describe('when the model cannot take the bytes natively', () => {
    beforeEach(() => {
      mocks.settingsStore.getCachedModels = vi.fn(() => [{
        id: 'gpt-vision',
        architecture: { input_modalities: ['text'] },
      }])
    })

    it('inlines text-like files instead of refusing them', async () => {
      const attachments = useAttachments()
      const file = new File(['export const a = 1'], 'main.ts', { type: 'text/plain' })

      const result = await attachments.processFiles([file])

      expect(result.rejected).toHaveLength(0)
      expect(result.accepted[0].delivery).toBe('inline-text')
    })

    it('treats an unknown extension as text-like — browsers report no MIME for .vue', async () => {
      const attachments = useAttachments()
      const file = new File(['<template />'], 'App.vue', { type: '' })

      const result = await attachments.processFiles([file])

      expect(result.accepted[0].delivery).toBe('inline-text')
    })

    it('falls back to the file path for binaries that exist on disk', async () => {
      const attachments = useAttachments()
      const file = withDiskPath(
        new File(['image-bytes'], 'diagram.png', { type: 'image/png' }),
        '/Users/me/diagram.png',
      )

      const result = await attachments.processFiles([file])

      expect(result.rejected).toHaveLength(0)
      expect(result.accepted[0].delivery).toBe('path-reference')
    })

    it('rejects only a pasted binary — nothing can carry it', async () => {
      const attachments = useAttachments()
      const file = new File(['image-bytes'], 'pasted.png', { type: 'image/png' })

      const result = await attachments.processFiles([file])

      expect(result.accepted).toHaveLength(0)
      expect(result.rejected[0].reason).toBe('undeliverable')
    })
  })

  it('caps the whole draft, not just each file', async () => {
    const attachments = useAttachments()
    const makeChunk = (name: string) => {
      const file = new File(['x'], name, { type: 'application/pdf' })
      Object.defineProperty(file, 'size', { value: 9 * 1024 * 1024 })
      return file
    }
    // Four 9 MB files each clear the 10 MB per-file check on their own.
    const files = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map(makeChunk)

    const result = await attachments.processFiles(files)

    expect(result.accepted).toHaveLength(3)
    expect(result.rejected[0]).toMatchObject({
      fileName: 'd.pdf',
      reason: 'draft-too-large',
    })
  })
})
