import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as chatPortModule from './chat-port'
import { useAttachmentImage } from './attachment-image'
import type { MessageAttachmentMetadata } from './message-attachments'

const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
const createObjectURL = vi.fn(() => 'blob:attachment-preview')
const revokeObjectURL = vi.fn()
const readBlob = vi.fn<(sessionId: string, hash: string) => Promise<{ base64?: string }>>()

function image(over: Partial<MessageAttachmentMetadata> = {}): MessageAttachmentMetadata {
  return { id: 'image-1', fileName: 'image.png', image: { mimeType: 'image/png' }, ...over }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

beforeEach(() => {
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  readBlob.mockReset().mockResolvedValue({})
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  vi.spyOn(chatPortModule, 'chatPort').mockResolvedValue({ readBlob } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

describe('附件图片加载', () => {
  it.each(['missing', 'throwing'])('object URL API %s 时安全降级', async (mode) => {
    if (mode === 'missing') Reflect.deleteProperty(URL, 'createObjectURL')
    else createObjectURL.mockImplementationOnce(() => { throw new Error('unsupported') })
    const attachment = image({ file: new File(['image'], 'image.png', { type: 'image/png' }) })
    const hook = renderHook(() => useAttachmentImage('s1', attachment))
    await waitFor(() => expect(hook.result.current.status).toBe('unavailable'))
    expect(readBlob).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('pending File 共用 object URL,最后一处卸载才释放', async () => {
    const attachment = image({ file: new File(['image'], 'image.png', { type: 'image/png' }) })
    const first = renderHook(() => useAttachmentImage('s1', attachment))
    const second = renderHook(() => useAttachmentImage('s1', attachment))
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    expect(second.result.current.src).toBe('blob:attachment-preview')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    first.unmount()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    second.unmount()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:attachment-preview')
    expect(readBlob).not.toHaveBeenCalled()
  })

  it('内联 base64 直接显示,优先于本地路径', async () => {
    const hook = renderHook(() => useAttachmentImage('s1', image({
      filePath: '/stored/image.png', image: { mimeType: 'image/png', base64Data: 'AID/' },
    })))
    await waitFor(() => expect(hook.result.current).toEqual({ status: 'ready', src: 'data:image/png;base64,AID/' }))
    expect(readBlob).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('同一会话/BlobRef 多处共用读取,重渲染不再拉取', async () => {
    const pending = deferred<{ base64: string }>()
    readBlob.mockReturnValue(pending.promise)
    const attachment = image({ image: { mimeType: 'image/png', base64Data: { hash: 'deadbeef', bytes: 3 } } })
    const first = renderHook(() => useAttachmentImage('s1', attachment))
    const second = renderHook(() => useAttachmentImage('s1', { ...attachment }))
    await waitFor(() => expect(readBlob).toHaveBeenCalledExactlyOnceWith('s1', 'deadbeef'))
    expect(first.result.current.status).toBe('loading')
    await act(async () => { pending.resolve({ base64: 'AID/' }); await pending.promise })
    expect(first.result.current.src).toBe('data:image/png;base64,AID/')
    expect(second.result.current.src).toBe('data:image/png;base64,AID/')
    second.rerender()
    expect(readBlob).toHaveBeenCalledTimes(1)
    first.unmount()
    second.unmount()
  })

  it('切换会话后旧读取晚到也不能覆盖新图片', async () => {
    const old = deferred<{ base64: string }>()
    readBlob.mockImplementation(sessionId => sessionId === 'old' ? old.promise : Promise.resolve({ base64: 'NEW' }))
    const attachment = image({ image: { mimeType: 'image/png', base64Data: { hash: 'deadbeef', bytes: 3 } } })
    const hook = renderHook(({ sessionId }) => useAttachmentImage(sessionId, attachment), { initialProps: { sessionId: 'old' } })
    await waitFor(() => expect(readBlob).toHaveBeenCalledWith('old', 'deadbeef'))
    hook.rerender({ sessionId: 'new' })
    await waitFor(() => expect(hook.result.current.src).toBe('data:image/png;base64,NEW'))
    await act(async () => { old.resolve({ base64: 'OLD' }); await old.promise })
    expect(hook.result.current.src).toBe('data:image/png;base64,NEW')
    hook.unmount()
  })

  it('卸载后忽略晚到读取并释放缓存,重新打开可重新读取', async () => {
    const pending = deferred<{ base64: string }>()
    readBlob.mockReturnValueOnce(pending.promise).mockResolvedValue({ base64: 'NEW' })
    const attachment = image({ image: { mimeType: 'image/png', base64Data: { hash: 'unmounted', bytes: 3 } } })
    const first = renderHook(() => useAttachmentImage('s1', attachment))
    await waitFor(() => expect(readBlob).toHaveBeenCalledTimes(1))
    first.unmount()
    await act(async () => { pending.resolve({ base64: 'OLD' }); await pending.promise })
    expect(first.result.current.status).toBe('loading')
    const second = renderHook(() => useAttachmentImage('s1', attachment))
    await waitFor(() => expect(second.result.current.src).toBe('data:image/png;base64,NEW'))
    expect(readBlob).toHaveBeenCalledTimes(2)
    second.unmount()
  })

  it('缺失或读取失败停在 unavailable,重渲染不无限重试', async () => {
    readBlob.mockRejectedValue(new Error('unavailable'))
    const attachment = image({ image: { mimeType: 'image/png', base64Data: { hash: 'missing', bytes: 3 } } })
    const hook = renderHook(() => useAttachmentImage('s1', { ...attachment }))
    await waitFor(() => expect(hook.result.current.status).toBe('unavailable'))
    hook.rerender()
    expect(readBlob).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it('只有路径的旧图片复用fileUrlOf;普通文件不读字节', async () => {
    const hook = renderHook(() => useAttachmentImage('s1', image({ filePath: '/stored/a #1.png' })))
    await waitFor(() => expect(hook.result.current.src).toBe('file:///stored/a%20%231.png'))
    const file = renderHook(() => useAttachmentImage('s1', { id: 'file', fileName: 'note.txt' }))
    expect(file.result.current.status).toBe('unavailable')
    expect(readBlob).not.toHaveBeenCalled()
    hook.unmount()
    file.unmount()
  })
})
