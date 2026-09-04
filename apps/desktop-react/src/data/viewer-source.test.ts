import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureFilesPort } from './files-port'
import type { FilesPort } from './files-port'
import { dirsQuery, useFilesSource } from './files-source'
import { useViewerSource } from './viewer-source'
import { VIEWER_CHUNK_BYTES, VIEWER_OVERSIZE_BYTES } from './viewer-kinds'

/**
 * 查看器的数据源。取数走假端口 —— 单元测试不碰盘、不碰网。
 *
 * 这一组要钉的四件:**定型**(五形 + 读失败各是各的)、**分段**、
 * **多实例**(W1:一个路径一份,两份互不串)、**分家**(它一个字都不碰 files-source)。
 */

/** 一份实例的读口。W1 之后「屏幕上那一份」这句话不成立了 —— 要问**哪一个**。 */
const inst = (path: string) => useViewerSource.getState().instances[path]

/**
 * 最后建出来的那一份。**只给「一次只谈一个文件」的那些用例**用 ——
 * 多实例那一组一律点名问 `inst(path)`,不许靠这句话蒙混。
 */
function latest() {
  const list = Object.values(useViewerSource.getState().instances)
  return list[list.length - 1] ?? { file: null, pending: null }
}

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
    expect(latest().file).toMatchObject({
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
    expect(latest().file?.kind).toBe('markdown')
  })

  it('位图**一个字节都不读**:src 直接是那条 file://', async () => {
    const port = fakePort()
    await useViewerSource.getState().openFile('/repo/logo.png')
    expect(port.readContent).not.toHaveBeenCalled()
    expect(latest().file).toMatchObject({
      kind: 'image',
      src: 'file:///repo/logo.png',
    })
    // 位图没有源码可切 —— 那一格如实缺席。
    expect(latest().file).not.toHaveProperty('svgSource', expect.anything())
  })

  it('svg 是图**也是**一段源码:两样都在手上', async () => {
    fakePort({
      readContent: vi.fn(async () => ({ success: true, content: '<svg/>', size: 6 })),
    })
    await useViewerSource.getState().openFile('/repo/icon.svg')
    expect(latest().file).toMatchObject({
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
    expect(latest().file).toEqual({
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
    expect(latest().file).toMatchObject({
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
    expect(latest().file).toEqual({
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
    expect(latest().file).toMatchObject({
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
    await useViewerSource.getState().loadMore('/repo/big.log')
    expect(port.readContent).toHaveBeenLastCalledWith('/repo/big.log', VIEWER_CHUNK_BYTES * 2)
    expect(latest().file).toMatchObject({ loaded: VIEWER_CHUNK_BYTES * 2 })
  })

  it('没截断就没有下一段可要 —— loadMore 什么都不做', async () => {
    const port = fakePort()
    await useViewerSource.getState().openFile('/repo/a.ts')
    ;(port.readContent as ReturnType<typeof vi.fn>).mockClear()
    await useViewerSource.getState().loadMore('/repo/a.ts')
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

describe('多实例:一个路径一份,两份互不串(W1)', () => {
  it('两份同时开着,各自的内容 / 草稿 / 滚动位分家', async () => {
    fakePort({
      readContent: vi.fn(async (path: string) => ({
        success: true as const,
        content: path === '/repo/a.ts' ? 'AAA' : 'BBB',
        size: 3,
      })),
    })
    await useViewerSource.getState().openFile('/repo/a.ts')
    await useViewerSource.getState().openFile('/repo/b.ts')
    expect(inst('/repo/a.ts').file).toMatchObject({ content: 'AAA' })
    expect(inst('/repo/b.ts').file).toMatchObject({ content: 'BBB' })

    // 草稿:改 A 不碰 B。
    useViewerSource.getState().setEditing('/repo/a.ts', true)
    useViewerSource.getState().setDraft('/repo/a.ts', 'A-changed')
    expect(inst('/repo/a.ts').edit.draft).toBe('A-changed')
    expect(inst('/repo/b.ts').edit.draft).toBeNull()

    // 滚动位:同上,而且它住在另一张表里(没有订阅者)。
    useViewerSource.getState().setScrollTop('/repo/a.ts', 120)
    expect(useViewerSource.getState().scrolls['/repo/a.ts']).toBe(120)
    expect(useViewerSource.getState().scrolls['/repo/b.ts']).toBe(0)
  })

  it('读 B 期间 A 那一份一个字没动(「切文件」不再是一次覆盖)', async () => {
    const second = gate()
    fakePort({
      readContent: vi.fn((path: string) =>
        path === '/repo/a.ts'
          ? Promise.resolve({ success: true as const, content: 'first', size: 5 })
          : second.promise,
      ),
    })
    await useViewerSource.getState().openFile('/repo/a.ts')
    const opening = useViewerSource.getState().openFile('/repo/b.ts')
    // A 那一份原样在手上;正在读的那一份自己说出 pending。
    expect(inst('/repo/a.ts').file).toMatchObject({ content: 'first' })
    expect(inst('/repo/a.ts').pending).toBeNull()
    expect(inst('/repo/b.ts').pending).toBe('/repo/b.ts')
    second.release('second')
    await opening
    expect(inst('/repo/b.ts').file).toMatchObject({ content: 'second' })
    expect(inst('/repo/a.ts').file).toMatchObject({ content: 'first' })
  })

  it('竞速是**逐路径**的:B 的回执不许把 A 那一发判过期', async () => {
    const a = gate()
    const b = gate()
    fakePort({
      readContent: vi.fn((path: string) => (path === '/repo/a.ts' ? a.promise : b.promise)),
    })
    const first = useViewerSource.getState().openFile('/repo/a.ts')
    const second = useViewerSource.getState().openFile('/repo/b.ts')
    // 先让**后发的**回来,再让先发的回来 —— 全局一个令牌的话 A 这一发会被判死。
    b.release('B')
    await second
    a.release('A')
    await first
    expect(inst('/repo/a.ts').file).toMatchObject({ content: 'A' })
    expect(inst('/repo/b.ts').file).toMatchObject({ content: 'B' })
  })

  it('同一条路径上,晚到的旧回执仍然不许把新内容盖掉', async () => {
    const slow = gate()
    let call = 0
    fakePort({
      readContent: vi.fn(() => {
        call += 1
        return call === 1 ? slow.promise : Promise.resolve({ success: true as const, content: 'new', size: 3 })
      }),
    })
    // 第一发还在飞的时候再点一次同一条路径(`openFile` 的幂等闸只挡「手上没有在飞的读」)。
    const stale = useViewerSource.getState().openFile('/repo/a.ts')
    await useViewerSource.getState().openFile('/repo/a.ts')
    expect(inst('/repo/a.ts').file).toMatchObject({ content: 'new' })
    slow.release('stale')
    await stale
    expect(inst('/repo/a.ts').file).toMatchObject({ content: 'new' })
  })

  it('再点一次同一个文件是幂等的 —— 不重读、屏幕不闪', async () => {
    const port = fakePort()
    await useViewerSource.getState().openFile('/repo/a.ts')
    ;(port.readContent as ReturnType<typeof vi.fn>).mockClear()
    await useViewerSource.getState().openFile('/repo/a.ts')
    expect(port.readContent).not.toHaveBeenCalled()
    // 真要重来走 reload —— 那是另一件事(盘上可能变了)。
    await useViewerSource.getState().reload('/repo/a.ts')
    expect(port.readContent).toHaveBeenCalledWith('/repo/a.ts', VIEWER_CHUNK_BYTES)
  })

  it('**隐藏不丢实例,关闭才丢**(设计 §2.3 那张表的数据侧)', async () => {
    fakePort()
    await useViewerSource.getState().openFile('/repo/a.ts')
    useViewerSource.getState().setEditing('/repo/a.ts', true)
    useViewerSource.getState().setDraft('/repo/a.ts', 'draft')
    // 「隐藏」在数据这一侧**什么都不做** —— 它只是把那一格从树里摘掉。
    expect(inst('/repo/a.ts').edit.draft).toBe('draft')
    // 「关闭」才 dispose。
    useViewerSource.getState().dispose('/repo/a.ts')
    expect(inst('/repo/a.ts')).toBeUndefined()
    expect(useViewerSource.getState().scrolls['/repo/a.ts']).toBeUndefined()
  })

  it('「我习惯怎么看」那两格跟着人走,新实例继承(折行 / 键位档)', async () => {
    fakePort()
    await useViewerSource.getState().openFile('/repo/a.ts')
    useViewerSource.getState().setView('/repo/a.ts', { wrap: true, keymap: 'vim' })
    await useViewerSource.getState().openFile('/repo/b.ts')
    expect(inst('/repo/b.ts').view.wrap).toBe(true)
    expect(inst('/repo/b.ts').view.keymap).toBe('vim')
    // 跟着文件走的那几格不继承。
    useViewerSource.getState().setView('/repo/a.ts', { showSource: true })
    await useViewerSource.getState().openFile('/repo/c.ts')
    expect(inst('/repo/c.ts').view.showSource).toBe(false)
  })
})

describe('分家:它不认识文件树', () => {
  it('开 / 关一个文件,files-source 一个字节都没动', async () => {
    fakePort()
    const before = useFilesSource.getState()
    await useViewerSource.getState().openFile('/repo/a.ts')
    useViewerSource.getState().dispose('/repo/a.ts')
    const after = useFilesSource.getState()
    expect(after.root).toBe(before.root)
    expect(after.expanded).toBe(before.expanded)
    // 目录缓存 7d 起住在 `dirsQuery` 那一族里 —— 「一格都没建过」比「引用没变」更强。
    expect(dirsQuery.keys()).toEqual([])
  })
})
