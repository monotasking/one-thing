import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesDirectoryEntry } from '@shared/ipc/files'
import { configureFilesPort } from './files-port'
import type { FilesPort } from './files-port'
import {
  PREVIEW_MAX_BYTES,
  baseNameOf,
  classifyFileFailure,
  flattenTree,
  formatBytes,
  langOfPath,
  sessionCwdOf,
  useFilesSource,
} from './files-source'
import type { DirState } from './files-source'
import { useNotifyStore } from '../services/notify-store'
import { useStageStore } from '../stage/store'
import { SESSIONS } from './__fixtures__/sessions'

/**
 * 文件面数据源的判据。取数走假端口 —— 单元测试不碰盘、不碰网。
 */

const ROOT = '/repo'

function dir(entries: FilesDirectoryEntry[]): DirState {
  return { status: 'ready', entries }
}

function entry(name: string, type: 'file' | 'directory', at = ROOT): FilesDirectoryEntry {
  return { name, path: `${at}/${name}`, type }
}

/** 假端口:每个方法都记账,好断言「问了几次」。 */
function fakePort(overrides: Partial<FilesPort> = {}) {
  const port: FilesPort = {
    ready: async () => undefined,
    listDirectory: vi.fn(async (path: string) => ({
      success: true,
      entries: [entry('a.ts', 'file', path)],
    })),
    stat: vi.fn(async () => ({ success: true, type: 'directory' as const, path: '/home/me' })),
    readContent: vi.fn(async () => ({ success: true, content: 'hello', size: 5 })),
    reveal: vi.fn(async () => ({ success: true })),
    list: vi.fn(async () => ({ success: true, files: [], entries: [] })),
    ...overrides,
  }
  configureFilesPort(port)
  return port
}

beforeEach(() => {
  useFilesSource.getState().reset()
  useNotifyStore.setState({ items: [] })
  useStageStore.setState({ locale: 'zh' })
})

describe('根目录的判据(单一产地)', () => {
  it('活跃会话的工作目录就是根 —— 产地是 SessionMeta.workingDirectory', () => {
    const withDir = SESSIONS.find((s) => s.projectId !== null)
    expect(withDir).toBeTruthy()
    expect(sessionCwdOf(SESSIONS, withDir!.id)).toBe(withDir!.projectId)
  })

  it('没选会话 / 找不到那条 / 那条没有工作目录 —— 三种都是 null,不猜一个出来', () => {
    const without = SESSIONS.find((s) => s.projectId === null)
    expect(sessionCwdOf(SESSIONS, '')).toBeNull()
    expect(sessionCwdOf(SESSIONS, '不存在的会话')).toBeNull()
    if (without) expect(sessionCwdOf(SESSIONS, without.id)).toBeNull()
  })

  it('拿不到工作目录时退 `~`,并且 `~` 是**后端**展开的(渲染层没有 homedir 这个事实)', async () => {
    const port = fakePort()
    await useFilesSource.getState().setRoot(null)
    expect(port.stat).toHaveBeenCalledWith('~')
    expect(useFilesSource.getState().root).toBe('/home/me')
    // 退了就说出来 —— 面板头据此如实交代「看的不是这条会话的工作目录」。
    expect(useFilesSource.getState().rootOrigin).toBe('home')
  })

  it('有工作目录时不去问 stat,直接用它', async () => {
    const port = fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    expect(port.stat).not.toHaveBeenCalled()
    expect(useFilesSource.getState().root).toBe(ROOT)
    expect(useFilesSource.getState().rootOrigin).toBe('session')
  })

  it('`~` 都展不开就是 error,不拿一个假路径去顶', async () => {
    fakePort({ stat: vi.fn(async () => ({ success: false, error: 'nope' })) })
    await useFilesSource.getState().setRoot(null)
    expect(useFilesSource.getState().rootStatus).toBe('error')
    expect(useFilesSource.getState().root).toBeNull()
    expect(useFilesSource.getState().rootError).toBe('nope')
  })

  it('换根把树整棵扔掉 —— 上一条会话展开的那几层不许跟过来', async () => {
    fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    await useFilesSource.getState().toggleDir(`${ROOT}/a.ts`)
    expect(Object.keys(useFilesSource.getState().expanded).length).toBe(1)
    await useFilesSource.getState().setRoot('/other')
    expect(useFilesSource.getState().expanded).toEqual({})
    expect(Object.keys(useFilesSource.getState().dirs)).toEqual(['/other'])
  })
})

describe('懒展开与每目录一次', () => {
  it('根拉一次;没展开的目录一次都不拉', async () => {
    const port = fakePort({
      listDirectory: vi.fn(async (path: string) => ({
        success: true,
        entries: [entry('src', 'directory', path), entry('a.ts', 'file', path)],
      })),
    })
    await useFilesSource.getState().setRoot(ROOT)
    expect(port.listDirectory).toHaveBeenCalledTimes(1)
    expect(port.listDirectory).toHaveBeenCalledWith(ROOT)
  })

  it('展开才拉,收起再展开**不再拉**(拉过就缓存)', async () => {
    const port = fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    const child = `${ROOT}/a.ts`
    await useFilesSource.getState().toggleDir(child)
    await useFilesSource.getState().toggleDir(child)
    await useFilesSource.getState().toggleDir(child)
    expect(port.listDirectory).toHaveBeenCalledTimes(2)
  })

  it('刷新清缓存并重拉根与所有仍然展开的目录 —— 树的形状不塌回一层', async () => {
    const port = fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    await useFilesSource.getState().toggleDir(`${ROOT}/a.ts`)
    ;(port.listDirectory as ReturnType<typeof vi.fn>).mockClear()
    await useFilesSource.getState().refresh()
    expect(port.listDirectory).toHaveBeenCalledTimes(2)
    expect(useFilesSource.getState().expanded).toEqual({ [`${ROOT}/a.ts`]: true })
  })

  it('读不到就记下后端原话,不静默当成空目录', async () => {
    fakePort({
      listDirectory: vi.fn(async () => ({ success: false, error: 'EACCES: permission denied' })),
    })
    await useFilesSource.getState().setRoot(ROOT)
    expect(useFilesSource.getState().dirs[ROOT]).toEqual({
      status: 'error',
      entries: [],
      error: 'EACCES: permission denied',
    })
  })
})

describe('摊平(投影,不是状态)', () => {
  it('根还没拉到 = 一行「正在读取」,而不是一张空树', () => {
    expect(flattenTree(ROOT, {}, {})).toEqual([
      { kind: 'note', id: `${ROOT}:loading`, depth: 0, note: 'loading' },
    ])
  })

  it('没有根就一行都没有', () => {
    expect(flattenTree(null, {}, {})).toEqual([])
  })

  it('展开的目录把孩子摊在它下面,深度加一;没展开的不摊', () => {
    const dirs = {
      [ROOT]: dir([entry('src', 'directory'), entry('a.ts', 'file')]),
      [`${ROOT}/src`]: dir([entry('b.ts', 'file', `${ROOT}/src`)]),
    }
    const closed = flattenTree(ROOT, dirs, {})
    expect(closed.map((r) => (r.kind === 'entry' ? r.name : r.note))).toEqual(['src', 'a.ts'])

    const open = flattenTree(ROOT, dirs, { [`${ROOT}/src`]: true })
    expect(open.map((r) => (r.kind === 'entry' ? `${r.depth}:${r.name}` : r.note))).toEqual([
      '0:src',
      '1:b.ts',
      '0:a.ts',
    ])
  })

  it('三种诚实交代各是一行:空 / 没权限 / 读不到', () => {
    const note = (state: DirState) => {
      const rows = flattenTree(ROOT, { [ROOT]: state }, {})
      return rows[0].kind === 'note' ? rows[0].note : rows[0].name
    }
    expect(note(dir([]))).toBe('empty')
    expect(note({ status: 'error', entries: [], error: 'Permission denied' })).toBe('denied')
    expect(note({ status: 'error', entries: [], error: 'boom' })).toBe('failed')
  })
})

describe('预览的四态', () => {
  it('读到了 = 内容 + 没被截断', async () => {
    fakePort()
    await useFilesSource.getState().openPreview('/repo/a.ts')
    expect(useFilesSource.getState().preview).toMatchObject({
      status: 'ready',
      content: 'hello',
      truncated: false,
    })
  })

  it('二进制自成一态 —— 不画一屏乱码,也不说「读不到」', async () => {
    fakePort({
      readContent: vi.fn(async () => ({ success: true, content: '', isBinary: true, size: 9 })),
    })
    await useFilesSource.getState().openPreview('/repo/x.png')
    expect(useFilesSource.getState().preview?.status).toBe('binary')
  })

  it('截断的判据是**真实字节数**与上限比,不是读回来那段的长度', async () => {
    fakePort({
      readContent: vi.fn(async () => ({
        success: true,
        content: 'x',
        size: PREVIEW_MAX_BYTES + 1,
      })),
    })
    await useFilesSource.getState().openPreview('/repo/big.log')
    expect(useFilesSource.getState().preview?.truncated).toBe(true)
  })

  it('读不到就归类 + 留原话', async () => {
    fakePort({ readContent: vi.fn(async () => ({ success: false, error: 'File not found' })) })
    await useFilesSource.getState().openPreview('/repo/gone.ts')
    expect(useFilesSource.getState().preview).toMatchObject({
      status: 'error',
      failure: 'missing',
      error: 'File not found',
    })
  })
})

describe('reveal:失败必须看得见', () => {
  it('成功就什么都不说', async () => {
    fakePort()
    await useFilesSource.getState().reveal('/repo/a.ts')
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('失败弹一条 error,并把后端原话原样带上', async () => {
    fakePort({
      reveal: vi.fn(async () => ({
        success: false,
        error: 'Revealing local files is not available in the web server runtime.',
      })),
    })
    await useFilesSource.getState().reveal('/repo/a.ts')
    expect(
      useNotifyStore.getState().items.map((x) => [x.level, x.source, x.body, x.detail]),
    ).toEqual([
      [
        'error',
        'files.reveal',
        '/repo/a.ts',
        'Revealing local files is not available in the web server runtime.',
      ],
    ])
  })
})

describe('文件检索(检索面的文件侧素材)', () => {
  it('空词 = 清空,一次请求都不发', async () => {
    const port = fakePort()
    await useFilesSource.getState().searchFiles('   ', ROOT)
    expect(port.list).not.toHaveBeenCalled()
    expect(useFilesSource.getState().searchHits).toEqual([])
  })

  it('带词就带着当前根问一次,并记下「这批结果是哪个词的」', async () => {
    const hits = [{ path: '/repo/a.ts', type: 'file' as const }]
    const port = fakePort({ list: vi.fn(async () => ({ success: true, files: [], entries: hits })) })
    await useFilesSource.getState().searchFiles(' model ', ROOT)
    expect(port.list).toHaveBeenCalledWith(expect.objectContaining({ cwd: ROOT, query: 'model' }))
    expect(useFilesSource.getState().searchHits).toEqual(hits)
    expect(useFilesSource.getState().searchQuery).toBe('model')
  })

  it('后端只给了 files 没给 entries 时,按路径补齐形状(两者同源)', async () => {
    fakePort({ list: vi.fn(async () => ({ success: true, files: ['/repo/a.ts'] })) })
    await useFilesSource.getState().searchFiles('a', ROOT)
    expect(useFilesSource.getState().searchHits).toEqual([{ path: '/repo/a.ts', type: 'file' }])
  })

  it('失败是 error 不是空结果 —— 两件事不许合成一件', async () => {
    fakePort({ list: vi.fn(async () => ({ success: false, files: [], error: 'nope' })) })
    await useFilesSource.getState().searchFiles('a', ROOT)
    expect(useFilesSource.getState().searchStatus).toBe('error')
    expect(useFilesSource.getState().searchError).toBe('nope')
  })
})

describe('小工具', () => {
  it('末段', () => {
    expect(baseNameOf('/a/b/c.ts')).toBe('c.ts')
    expect(baseNameOf('/a/b/')).toBe('b')
    expect(baseNameOf('/')).toBe('/')
  })

  it('扩展名认不出就是素文本,不是错误', () => {
    expect(langOfPath('/a/b.ts')).toBe('typescript')
    expect(langOfPath('/a/b.md')).toBe('markdown')
    expect(langOfPath('/a/Makefile')).toBeNull()
    expect(langOfPath('/a/.gitignore')).toBeNull()
    expect(langOfPath('/a/b.wat')).toBeNull()
  })

  it('字节数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB')
  })

  it('沙箱越界归 denied —— 对用户来说它就是「这台不让我读那儿」', () => {
    expect(classifyFileFailure('Path must stay inside the workspace sandbox root.')).toBe('denied')
    expect(classifyFileFailure(undefined)).toBe('failed')
  })
})
