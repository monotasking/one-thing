import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureFilesPort } from './files-port'
import type { FilesPort } from './files-port'
import { dirsQuery, useFilesSource } from './files-source'
import { useViewerSource } from './viewer-source'
import { VIEWER_CHUNK_BYTES, VIEWER_OVERSIZE_BYTES } from './viewer-kinds'

/**
 * 查看器的数据源。取数走假端口 —— 单元测试不碰盘、不碰网。
 *
 * 这一组要钉的三件:**定型**(五形 + 读失败各是各的)、**切文件不闪**
 * (旧内容留到新内容到场)、**分家**(它一个字都不碰 files-source)。
 */

function fakePort(overrides: Partial<FilesPort> = {}) {
  const port: FilesPort = {
    ready: async () => undefined,
    listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
    stat: vi.fn(async () => ({ success: true, type: 'file' as const, path: '/repo/a.ts' })),
    readContent: vi.fn(async () => ({ success: true, content: 'hello\n', size: 6 })),
    saveContent: async () => ({ success: true }),
    reveal: vi.fn(async () => ({ success: true })),
    list: vi.fn(async () => ({ success: true, files: [], entries: [] })),
    ...overrides,
  }
  configureFilesPort(port)
  return port
}

beforeEach(() => {
  useViewerSource.getState().reset()
  useFilesSource.getState().reset()
})

describe('定型:五形 + 一态', () => {
  it('code —— 内容 + 语言 + 没被截断', async () => {
    fakePort()
    await useViewerSource.getState().openFile('/repo/a.ts')
    expect(useViewerSource.getState().file).toMatchObject({
      kind: 'code',
      path: '/repo/a.ts',
      name: 'a.ts',
      lang: 'typescript',
      content: 'hello\n',
      truncated: false,
    })
  })

  it('markdown 自成一形(它要走块翻译表,不是一段带高亮的文本)', async () => {
    fakePort({ readContent: vi.fn(async () => ({ success: true, content: '# hi', size: 4 })) })
    await useViewerSource.getState().openFile('/repo/README.md')
    expect(useViewerSource.getState().file?.kind).toBe('markdown')
  })

  it('位图**一个字节都不读**:src 直接是那条 file://', async () => {
    const port = fakePort()
    await useViewerSource.getState().openFile('/repo/logo.png')
    expect(port.readContent).not.toHaveBeenCalled()
    expect(useViewerSource.getState().file).toMatchObject({
      kind: 'image',
      src: 'file:///repo/logo.png',
    })
    // 位图没有源码可切 —— 那一格如实缺席。
    expect(useViewerSource.getState().file).not.toHaveProperty('svgSource', expect.anything())
  })

  it('svg 是图**也是**一段源码:两样都在手上', async () => {
    fakePort({
      readContent: vi.fn(async () => ({ success: true, content: '<svg/>', size: 6 })),
    })
    await useViewerSource.getState().openFile('/repo/icon.svg')
    expect(useViewerSource.getState().file).toMatchObject({
      kind: 'image',
      src: 'file:///repo/icon.svg',
      svgSource: '<svg/>',
    })
  })

  it('二进制:不给内容,大小如实(后端没给就缺席,不拿 0 顶)', async () => {
    fakePort({
      readContent: vi.fn(async () => ({ success: true, content: '', isBinary: true, size: 900 })),
    })
    await useViewerSource.getState().openFile('/repo/blob.dat')
    expect(useViewerSource.getState().file).toEqual({
      kind: 'binary',
      path: '/repo/blob.dat',
      name: 'blob.dat',
      size: 900,
    })
  })

  it('太大:自成一形,并把闸值一起交出去(界面要说得出「超过多少」)', async () => {
    fakePort({
      readContent: vi.fn(async () => ({
        success: true,
        content: 'x',
        size: VIEWER_OVERSIZE_BYTES + 1,
      })),
    })
    await useViewerSource.getState().openFile('/repo/huge.log')
    expect(useViewerSource.getState().file).toMatchObject({
      kind: 'oversize',
      limit: VIEWER_OVERSIZE_BYTES,
      size: VIEWER_OVERSIZE_BYTES + 1,
    })
  })

  it('读不到:归类 + 后端原话原样', async () => {
    fakePort({
      readContent: vi.fn(async () => ({ success: false, error: 'EACCES: permission denied' })),
    })
    await useViewerSource.getState().openFile('/repo/secret.ts')
    expect(useViewerSource.getState().file).toEqual({
      kind: 'error',
      path: '/repo/secret.ts',
      name: 'secret.ts',
      failure: 'denied',
      error: 'EACCES: permission denied',
    })
  })
})

describe('分段:首段 + 「继续加载」', () => {
  it('第一次只要一段;真实字节数比它大就是截断', async () => {
    const port = fakePort({
      readContent: vi.fn(async () => ({
        success: true,
        content: 'head',
        size: VIEWER_CHUNK_BYTES * 2,
      })),
    })
    await useViewerSource.getState().openFile('/repo/big.log')
    expect(port.readContent).toHaveBeenCalledWith('/repo/big.log', VIEWER_CHUNK_BYTES)
    expect(useViewerSource.getState().file).toMatchObject({
      truncated: true,
      loaded: VIEWER_CHUNK_BYTES,
    })
  })

  it('「继续加载」= 重读一段更长的前缀(端口没有 offset,这是有意的取舍)', async () => {
    const port = fakePort({
      readContent: vi.fn(async () => ({
        success: true,
        content: 'head',
        size: VIEWER_CHUNK_BYTES * 4,
      })),
    })
    await useViewerSource.getState().openFile('/repo/big.log')
    await useViewerSource.getState().loadMore()
    expect(port.readContent).toHaveBeenLastCalledWith('/repo/big.log', VIEWER_CHUNK_BYTES * 2)
    expect(useViewerSource.getState().file).toMatchObject({ loaded: VIEWER_CHUNK_BYTES * 2 })
  })

  it('没截断就没有下一段可要 —— loadMore 什么都不做', async () => {
    const port = fakePort()
    await useViewerSource.getState().openFile('/repo/a.ts')
    ;(port.readContent as ReturnType<typeof vi.fn>).mockClear()
    await useViewerSource.getState().loadMore()
    expect(port.readContent).not.toHaveBeenCalled()
  })
})

/**
 * 一条**先造好**的回执闸。
 *
 * 不能等 `readContent` 被调用的那一刻再抓 resolve:端口本身是 `await filesPort()`
 * 拿到的(惰性),所以 `openFile` 到真正调 readContent 之间隔着一个微任务 ——
 * 在那之前去放闸,手上还是 undefined,用例就吊死在那儿。先造好就没有这个时序。
 */
function gate() {
  let open: ((value: { success: true; content: string; size: number }) => void) | undefined
  const promise = new Promise<{ success: true; content: string; size: number }>((resolve) => {
    open = resolve
  })
  return { promise, release: (content: string) => open?.({ success: true, content, size: content.length }) }
}

describe('切文件不闪:旧内容留到新内容到场', () => {
  it('读新文件期间 `file` 还是旧那一份,`pending` 说出正在读谁', async () => {
    const second = gate()
    fakePort({
      readContent: vi.fn((path: string) =>
        path === '/repo/a.ts'
          ? Promise.resolve({ success: true as const, content: 'first', size: 5 })
          : second.promise,
      ),
    })
    await useViewerSource.getState().openFile('/repo/a.ts')
    expect(useViewerSource.getState().file).toMatchObject({ content: 'first' })

    const opening = useViewerSource.getState().openFile('/repo/b.ts')
    // 屏幕上**没有任何一帧是空的**:旧内容还在,读数说着新的那条路径。
    expect(useViewerSource.getState().file).toMatchObject({ path: '/repo/a.ts' })
    expect(useViewerSource.getState().pending).toBe('/repo/b.ts')

    second.release('second')
    await opening
    expect(useViewerSource.getState().file).toMatchObject({ path: '/repo/b.ts', content: 'second' })
    expect(useViewerSource.getState().pending).toBeNull()
  })

  it('竞速:晚到的旧回执不许把新内容盖掉', async () => {
    const a = gate()
    const b = gate()
    fakePort({
      readContent: vi.fn((path: string) => (path === '/repo/a.ts' ? a.promise : b.promise)),
    })
    const first = useViewerSource.getState().openFile('/repo/a.ts')
    const second = useViewerSource.getState().openFile('/repo/b.ts')
    // 先让**后发的**回来,再让先发的回来。
    b.release('B')
    await second
    a.release('A')
    await first
    expect(useViewerSource.getState().file).toMatchObject({ path: '/repo/b.ts', content: 'B' })
  })

  it('点一张图会把还在飞的那次读判过期(否则它回来会把图盖掉)', async () => {
    const slowGate = gate()
    fakePort({ readContent: vi.fn(() => slowGate.promise) })
    const slow = useViewerSource.getState().openFile('/repo/a.ts')
    await useViewerSource.getState().openFile('/repo/logo.png')
    expect(useViewerSource.getState().file?.kind).toBe('image')
    slowGate.release('late')
    await slow
    expect(useViewerSource.getState().file?.kind).toBe('image')
  })

  it('再点一次同一个文件是幂等的 —— 不重读、屏幕不闪', async () => {
    const port = fakePort()
    await useViewerSource.getState().openFile('/repo/a.ts')
    ;(port.readContent as ReturnType<typeof vi.fn>).mockClear()
    await useViewerSource.getState().openFile('/repo/a.ts')
    expect(port.readContent).not.toHaveBeenCalled()
    // 真要重来走 reload —— 那是另一件事(盘上可能变了)。
    await useViewerSource.getState().reload()
    expect(port.readContent).toHaveBeenCalledWith('/repo/a.ts', VIEWER_CHUNK_BYTES)
  })

  it('关掉 = 两格都清空', async () => {
    fakePort()
    await useViewerSource.getState().openFile('/repo/a.ts')
    useViewerSource.getState().close()
    expect(useViewerSource.getState().file).toBeNull()
    expect(useViewerSource.getState().pending).toBeNull()
  })
})

describe('分家:它不认识文件树', () => {
  it('开 / 关一个文件,files-source 一个字节都没动', async () => {
    fakePort()
    const before = useFilesSource.getState()
    await useViewerSource.getState().openFile('/repo/a.ts')
    useViewerSource.getState().close()
    const after = useFilesSource.getState()
    expect(after.root).toBe(before.root)
    expect(after.expanded).toBe(before.expanded)
    // 目录缓存 7d 起住在 `dirsQuery` 那一族里 —— 「一格都没建过」比「引用没变」更强。
    expect(dirsQuery.keys()).toEqual([])
  })
})
