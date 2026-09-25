import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureMediaImagePort,
  peekMediaImage,
  resetMediaImageCacheForTest,
  useMediaImage,
} from './media-image'

/**
 * 媒体库图的读取缓存(G 线 P5-a §23.3)—— 与 `attachment-image.ts` 的 `acquireBlob` 同形:
 * 同名只读一次、最后一个读者离开且那一发已落定才释放、晚到的结果不串到新名字上。
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const readFile = vi.fn<(fileName: string) => Promise<{ dataUrl: string | null }>>()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  resetMediaImageCacheForTest()
  readFile.mockReset().mockResolvedValue({ dataUrl: PNG })
  configureMediaImagePort({ readFile })
})

afterEach(() => {
  configureMediaImagePort(undefined)
})

describe('媒体库图读取', () => {
  it('两处同名只发一次请求;两处都拿到同一只 data URL', async () => {
    const first = renderHook(() => useMediaImage('m.png'))
    const second = renderHook(() => useMediaImage('m.png'))
    await waitFor(() => expect(first.result.current).toEqual({ status: 'ready', src: PNG }))
    await waitFor(() => expect(second.result.current.status).toBe('ready'))
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(peekMediaImage('m.png')).toBe(PNG)
    first.unmount()
    // 还有一个读者:缓存不许撤。
    expect(peekMediaImage('m.png')).toBe(PNG)
    second.unmount()
    // 最后一个读者走了:这一格撤掉,下次再开重新读(data URL 几 MB,不常驻)。
    expect(peekMediaImage('m.png')).toBeUndefined()
    const again = renderHook(() => useMediaImage('m.png'))
    await waitFor(() => expect(again.result.current.status).toBe('ready'))
    expect(readFile).toHaveBeenCalledTimes(2)
    again.unmount()
  })

  it('读者在请求落定前就走光:落定时撤掉,不留孤儿', async () => {
    const gate = deferred<{ dataUrl: string | null }>()
    readFile.mockReturnValueOnce(gate.promise)
    const hook = renderHook(() => useMediaImage('late.png'))
    expect(hook.result.current.status).toBe('loading')
    hook.unmount()
    gate.resolve({ dataUrl: PNG })
    await waitFor(() => expect(peekMediaImage('late.png')).toBeUndefined())
  })

  it('null / 抛错都落 unavailable(没有这个文件、无权、连不上 —— 屏幕上是同一句话)', async () => {
    readFile.mockResolvedValueOnce({ dataUrl: null })
    const missing = renderHook(() => useMediaImage('missing.png'))
    await waitFor(() => expect(missing.result.current).toEqual({ status: 'unavailable' }))
    readFile.mockRejectedValueOnce(new Error('offline'))
    const broken = renderHook(() => useMediaImage('broken.png'))
    await waitFor(() => expect(broken.result.current).toEqual({ status: 'unavailable' }))
    missing.unmount()
    broken.unmount()
  })

  it('换名字立即撤旧 src,旧名晚到的结果不串过来', async () => {
    const slow = deferred<{ dataUrl: string | null }>()
    readFile.mockImplementation((name) => (name === 'a.png' ? slow.promise : Promise.resolve({ dataUrl: 'data:image/png;base64,Qg==' })))
    const hook = renderHook(({ name }) => useMediaImage(name), { initialProps: { name: 'a.png' } })
    hook.rerender({ name: 'b.png' })
    await waitFor(() => expect(hook.result.current).toEqual({ status: 'ready', src: 'data:image/png;base64,Qg==' }))
    slow.resolve({ dataUrl: PNG })
    await Promise.resolve()
    expect(hook.result.current.src).toBe('data:image/png;base64,Qg==')
    hook.unmount()
  })

  it('名字缺席 = 不是媒体库图:什么都不读', () => {
    const hook = renderHook(() => useMediaImage(undefined))
    expect(hook.result.current).toEqual({ status: 'unavailable' })
    expect(readFile).not.toHaveBeenCalled()
    hook.unmount()
  })
})
