import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('electron', () => ({
  protocol: { handle: mocks.handle },
  net: { fetch: mocks.fetch },
}))

describe('electron media protocol', () => {
  it('registers media scheme and resolves files from the injected media dir', async () => {
    const { registerElectronMediaProtocol } = await import('../protocol.js')
    const response = new Response('ok')
    const fetch = vi.fn().mockResolvedValue(response)
    const handle = vi.fn()

    registerElectronMediaProtocol({
      getMediaImagesDir: () => '/tmp/onething media',
      handle: handle as any,
      fetch: fetch as any,
    })

    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls[0][0]).toBe('media')

    await expect(handle.mock.calls[0][1]({
      url: 'media://folder%20one/image.png',
    })).resolves.toBe(response)
    expect(fetch.mock.calls[0][0]).toBe('file:///tmp/onething%20media/folder%20one/image.png')
  })

  it('falls through to the files dir when the name is not an image', async () => {
    const { registerElectronMediaProtocol } = await import('../protocol.js')
    const response = new Response('ok')
    const fetch = vi.fn().mockResolvedValue(response)
    const handle = vi.fn()

    registerElectronMediaProtocol({
      getMediaImagesDir: () => '/store/images',
      getMediaFilesDir: () => '/store/files',
      // 只有 files/ 里那份存在 —— 拖进来的 PDF 就是这个形状。
      exists: filePath => filePath === '/store/files/brief.pdf',
      handle: handle as any,
      fetch: fetch as any,
    })

    await handle.mock.calls[0][1]({ url: 'media://brief.pdf' })
    expect(fetch.mock.calls[0][0]).toBe('file:///store/files/brief.pdf')
  })

  it('prefers the images dir when both directories hold the name', async () => {
    const { registerElectronMediaProtocol } = await import('../protocol.js')
    const fetch = vi.fn().mockResolvedValue(new Response('ok'))
    const handle = vi.fn()

    registerElectronMediaProtocol({
      getMediaImagesDir: () => '/store/images',
      getMediaFilesDir: () => '/store/files',
      exists: () => true,
      handle: handle as any,
      fetch: fetch as any,
    })

    await handle.mock.calls[0][1]({ url: 'media://both.png' })
    expect(fetch.mock.calls[0][0]).toBe('file:///store/images/both.png')
  })

  /**
   * `media://` 的名字整个来自渲染进程,所以 `../` 必须在解析后被前缀比对挡住 ——
   * 否则这条协议就是一个任意文件读取器。
   */
  it('refuses a name that resolves outside both media directories', async () => {
    const { registerElectronMediaProtocol } = await import('../protocol.js')
    const fetch = vi.fn().mockResolvedValue(new Response('ok'))
    const handle = vi.fn()

    registerElectronMediaProtocol({
      getMediaImagesDir: () => '/store/images',
      getMediaFilesDir: () => '/store/files',
      exists: () => true,
      handle: handle as any,
      fetch: fetch as any,
    })

    const escaped = await handle.mock.calls[0][1]({
      url: 'media://../../../etc/passwd',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(escaped.status).toBe(404)
  })

  it('defaults to Electron protocol and net adapters', async () => {
    const { registerElectronMediaProtocol } = await import('../protocol.js')

    registerElectronMediaProtocol({
      getMediaImagesDir: () => '/tmp/media',
    })

    expect(mocks.handle).toHaveBeenCalledWith('media', expect.any(Function))
  })
})
