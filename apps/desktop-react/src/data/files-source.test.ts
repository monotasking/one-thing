import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesDirectoryEntry } from '@shared/ipc/files'
import { configureFilesPort } from './files-port'
import type { FilesPort } from './files-port'
import {
  FILES_ROW_H,
  FILE_SEARCH_LIMIT,
  baseNameOf,
  breadcrumbsOf,
  classifyFileFailure,
  flattenTree,
  formatMtime,
  langOfPath,
  currentFileDetail,
  detailQuery,
  dirStateAt,
  dirsQuery,
  revealMutation,
  swapFilesForSpace,
  rowWindow,
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

/** 跨文件执法:行高的 JS 侧与 CSS 侧是同一个数(同 motion-tokens.test 的判例)。 */
const tokensCss = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles/tokens.css'),
  'utf-8',
)

function dir(entries: FilesDirectoryEntry[]): DirState {
  return { phase: 'ready', inflight: false, entries }
}

/** 读失败的那一档。`phase` 说的是「有没有过内容」,与 error 正交(7d)。 */
function failed(error: string, entries: FilesDirectoryEntry[] = []): DirState {
  return { phase: entries.length ? 'ready' : 'initial', inflight: false, entries, error }
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
    saveContent: async () => ({ success: true }),
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
    expect(dirsQuery.keys()).toEqual(['/other'])
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

  it('刷新重拉根与所有仍然展开的目录 —— 树的形状不塌回一层(7d 起**不清缓存**)', async () => {
    const port = fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    await useFilesSource.getState().toggleDir(`${ROOT}/a.ts`)
    ;(port.listDirectory as ReturnType<typeof vi.fn>).mockClear()
    await useFilesSource.getState().refresh()
    expect(port.listDirectory).toHaveBeenCalledTimes(2)
    expect(useFilesSource.getState().expanded).toEqual({ [`${ROOT}/a.ts`]: true })
  })

  /*
   * ── 病型 A 的反证(7d 拍板一)─────────────────────────────────────────
   * 修前 `refresh()` 有一句 `set({ dirs: {} })`,真机探针采到:5 行的树掉到 3 行、
   * 出现 1 条骨架、节点身份全换。这一组把那三件事各钉一句 —— 把那句 set 换回去
   * (或者把 `refetch` 换成 `reset` + 重拉)必红。
   */
  it('刷新期间旧 entries 留在屏上:phase 不退回 initial,一条骨架都不画', async () => {
    fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    const child = `${ROOT}/a.ts`
    await useFilesSource.getState().toggleDir(child)
    const before = dirStateAt(ROOT).entries

    const running = useFilesSource.getState().refresh()
    // **在飞的这一刻**看:这一层还有内容、还是 ready、屏幕上没有骨架。
    const midway = dirStateAt(ROOT)
    expect(midway.entries).toBe(before)
    expect(midway.phase).toBe('ready')
    expect(midway.inflight).toBe(true)
    const rows = flattenTree(ROOT, { [ROOT]: midway, [child]: dirStateAt(child) }, { [child]: true })
    expect(rows.some((r) => r.kind === 'skeleton')).toBe(false)
    await running
  })

  it('刷新回来答案没变 = 连数组引用都不换(律④:行身份不许整树重换)', async () => {
    fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    const before = dirStateAt(ROOT).entries
    await useFilesSource.getState().refresh()
    expect(dirStateAt(ROOT).entries).toBe(before)
  })

  it('收起来的那些格刷新时标脏而不是重拉 —— 再展开才去问,而且问的是新的', async () => {
    const port = fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    const child = `${ROOT}/a.ts`
    await useFilesSource.getState().toggleDir(child)
    useFilesSource.getState().collapseAll()
    ;(port.listDirectory as ReturnType<typeof vi.fn>).mockClear()

    await useFilesSource.getState().refresh()
    // 收着的那一层不在刷新的名单里:只有根被重拉。
    expect(port.listDirectory).toHaveBeenCalledTimes(1)
    expect(port.listDirectory).toHaveBeenCalledWith(ROOT)
    // 但它被标脏了,所以再展开会真的去问一次(旧代码靠「整族清空」附带做到这件事)。
    await useFilesSource.getState().toggleDir(child)
    expect(port.listDirectory).toHaveBeenCalledWith(child)
  })

  it('一层读失败:旧行留在屏上,错误行画在它前面(拍板二)', async () => {
    let ok = true
    fakePort({
      listDirectory: vi.fn(async (path: string) =>
        ok
          ? { success: true, entries: [entry('a.ts', 'file', path)] }
          : { success: false, error: 'EACCES: permission denied' },
      ),
    })
    await useFilesSource.getState().setRoot(ROOT)
    const before = dirStateAt(ROOT).entries
    ok = false
    await useFilesSource.getState().retryDir(ROOT)

    const state = dirStateAt(ROOT)
    // 旧内容原样留着(律②的一半),错误原话与它并存(另一半)。
    expect(state.entries).toBe(before)
    expect(state.error).toBe('EACCES: permission denied')
    const rows = flattenTree(ROOT, { [ROOT]: state }, {})
    expect(rows.map((r) => (r.kind === 'entry' ? r.name : `${r.kind}:${r.kind === 'note' ? r.note : ''}`))).toEqual([
      'note:denied',
      'a.ts',
    ])
  })

  it('从来没读到过就失败时,只有那一行错误 —— 不再多说一句「这里是空的」', async () => {
    fakePort({ listDirectory: vi.fn(async () => ({ success: false, error: 'boom' })) })
    await useFilesSource.getState().setRoot(ROOT)
    const rows = flattenTree(ROOT, { [ROOT]: dirStateAt(ROOT) }, {})
    expect(rows.length).toBe(1)
    expect(rows[0].kind === 'note' && rows[0].note).toBe('failed')
  })

  it('读不到就记下后端原话,不静默当成空目录', async () => {
    fakePort({
      listDirectory: vi.fn(async () => ({ success: false, error: 'EACCES: permission denied' })),
    })
    await useFilesSource.getState().setRoot(ROOT)
    expect(dirStateAt(ROOT)).toEqual({
      phase: 'initial',
      inflight: false,
      entries: [],
      error: 'EACCES: permission denied',
    })
  })
})

describe('摊平(投影,不是状态)', () => {
  /*
   * 定稿改判:「正在读取」那四个字换成两条骨架短横。**两行而不是一行**是硬约束 ——
   * 窗口化渲染按「行序 × 行高」反推位置,一个两倍高的特例会把整条卷轴算歪。
   */
  it('根还没拉到 = 两条骨架短横(各占一行),而不是一张空树', () => {
    expect(flattenTree(ROOT, {}, {})).toEqual([
      { kind: 'skeleton', id: `${ROOT}:skel:1`, depth: 0, bar: 1 },
      { kind: 'skeleton', id: `${ROOT}:skel:2`, depth: 0, bar: 2 },
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
    expect(closed.map((r) => (r.kind === 'entry' ? r.name : r.kind))).toEqual(['src', 'a.ts'])

    const open = flattenTree(ROOT, dirs, { [`${ROOT}/src`]: true })
    expect(open.map((r) => (r.kind === 'entry' ? `${r.depth}:${r.name}` : r.kind))).toEqual([
      '0:src',
      '1:b.ts',
      '0:a.ts',
    ])
  })

  it('三种诚实交代各是一行:空 / 没权限 / 读不到', () => {
    const note = (state: DirState) => {
      const rows = flattenTree(ROOT, { [ROOT]: state }, {})
      return rows[0].kind === 'note' ? rows[0].note : rows[0].kind
    }
    expect(note(dir([]))).toBe('empty')
    expect(note(failed('Permission denied'))).toBe('denied')
    expect(note(failed('boom'))).toBe('failed')
  })

  it('失败那一行带着它说的是**哪个目录** —— 「重试」拿它去重拉', () => {
    const rows = flattenTree(ROOT, { [ROOT]: failed('boom') }, {})
    expect(rows[0].kind === 'note' && rows[0].dir).toBe(ROOT)
  })

  /*
   * ── 符号链接环:不栈溢出,每个目录只出一次(7d)─────────────────────────
   * 这份夹具**不是编的**:7d 写「刷新在飞」那条用例时喂错了一层假答案,让
   * `${ROOT}/packages/core` 回了一批指回 `${ROOT}/packages` 的条目,`walk` 当场
   * RangeError: Maximum call stack size exceeded,整块 FilesPanel 被 ErrorBoundary
   * 接走。真产地是符号链接:后端 `listDirectory` 直接 readdir,一个指回祖先的
   * 链接会照实回一条 `type:'directory'`,它不解引用也不判环。
   * 把 `seen` 那一格去掉,这条必红(而且是栈溢出那种红)。
   */
  it('符号链接环:不栈溢出,而且每个目录在表里只出一次', () => {
    const a = `${ROOT}/a`
    const b = `${ROOT}/b`
    // a 里有 b,b 里又有 a —— 盘上就是一对互指的符号链接。
    const dirs = {
      [ROOT]: dir([entry('a', 'directory')]),
      [a]: dir([{ name: 'b', path: b, type: 'directory' as const }]),
      [b]: dir([{ name: 'a', path: a, type: 'directory' as const }]),
    }
    const rows = flattenTree(ROOT, dirs, { [a]: true, [b]: true })

    // 环里那三层各画一行,第二次遇到 a 时**那一行还在**(它是 b 里真有的一项),
    // 只是不再把 a 的孩子摊第二遍 —— 摊了就是屏幕上的重影。
    expect(rows.map((r) => (r.kind === 'entry' ? `${r.depth}:${r.name}` : r.kind))).toEqual([
      '0:a',
      '1:b',
      '2:a',
    ])
  })
})

/**
 * 窗口化的算术。它是纯函数,所以这里一行 React 都不渲染 —— 钉的是
 * 「卷到这儿的时候该画哪一段、前后各垫多高」这件事本身。
 */
describe('窗口化:只画看得见的那一段', () => {
  it('行高与 tokens.css 的 --files-row-h 是同一个数(一处改了另一处必须跟)', () => {
    expect(tokensCss).toContain(`--files-row-h: ${FILES_ROW_H}px`)
  })

  it('一屏 10 行的视口:卷在顶上时画的是「窗口 + 下缓冲」,不是全表', () => {
    const win = rowWindow(1000, 0, 10 * FILES_ROW_H)
    expect(win.start).toBe(0)
    // 可视 10 行 +1(半行)+ 8 行缓冲
    expect(win.end).toBe(19)
    expect(win.padTop).toBe(0)
    expect(win.padBottom).toBe((1000 - 19) * FILES_ROW_H)
  })

  it('卷到中间:上下各留 8 行缓冲,撑子把卷轴长度补回原样', () => {
    const win = rowWindow(1000, 100 * FILES_ROW_H, 10 * FILES_ROW_H)
    expect(win.start).toBe(92)
    expect(win.end).toBe(119)
    // 撑子 + 画出来的行 = 全表高度,所以卷轴与「全画出来」逐像素相同。
    expect(win.padTop + (win.end - win.start) * FILES_ROW_H + win.padBottom).toBe(
      1000 * FILES_ROW_H,
    )
  })

  it('卷到底:窗口夹在表尾,padBottom 归零', () => {
    const win = rowWindow(50, 40 * FILES_ROW_H, 10 * FILES_ROW_H)
    expect(win.end).toBe(50)
    expect(win.padBottom).toBe(0)
  })

  it('还没量到视口(第一帧 / 面被收着)= 整表窗口,宁可多画也不画一片空白', () => {
    expect(rowWindow(300, 0, 0)).toEqual({ start: 0, end: 300, padTop: 0, padBottom: 0 })
  })

  it('空表就是空窗口', () => {
    expect(rowWindow(0, 0, 400)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })
})

/*
 * 「预览的四态」那一组搬去了 `viewer-source.test.ts`(查看器 F1)——
 * 连同 openPreview / PreviewState 一起。这个 store 从此只说目录的事实。
 */

describe('reveal:失败必须看得见', () => {
  it('成功就什么都不说', async () => {
    fakePort()
    await revealMutation.run('/repo/a.ts')
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('失败弹一条 error,并把后端原话原样带上', async () => {
    fakePort({
      reveal: vi.fn(async () => ({
        success: false,
        error: 'Revealing local files is not available in the web server runtime.',
      })),
    })
    await revealMutation.run('/repo/a.ts')
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

  /*
   * ── 7d 拍板三:失败不清命中,判据是「同不同一个问题」──────────────────
   * 同一个词的重查(翻页要更多条)失败 → 用户正在读的那一页留在屏上;
   * 换了词才失败 → 那批命中说的是别的词,留着就是在屏幕上说谎。
   */
  it('同一个词翻页失败:旧命中留在屏上,错误并陈', async () => {
    const hits = [{ path: '/repo/a.ts', type: 'file' as const }]
    let ok = true
    fakePort({
      list: vi.fn(async () =>
        ok ? { success: true, files: [], entries: hits } : { success: false, files: [], error: 'nope' },
      ),
    })
    await useFilesSource.getState().searchFiles('model', ROOT)
    ok = false
    await useFilesSource.getState().searchFiles('model', ROOT, 80)

    const st = useFilesSource.getState()
    expect(st.searchHits).toEqual(hits)
    expect(st.searchStatus).toBe('error')
    expect(st.searchError).toBe('nope')
    // 取尽判据跟着**手上这批**走,不跟着那次失败的请求走。
    expect(st.searchLimit).toBe(FILE_SEARCH_LIMIT)
  })

  it('换了词才失败:上一个词那批命中不许留着冒充这个词的答案', async () => {
    const hits = [{ path: '/repo/a.ts', type: 'file' as const }]
    let ok = true
    fakePort({
      list: vi.fn(async () =>
        ok ? { success: true, files: [], entries: hits } : { success: false, files: [], error: 'nope' },
      ),
    })
    await useFilesSource.getState().searchFiles('model', ROOT)
    ok = false
    await useFilesSource.getState().searchFiles('router', ROOT)

    const st = useFilesSource.getState()
    expect(st.searchHits).toEqual([])
    expect(st.searchQuery).toBe('router')
    expect(st.searchLimit).toBe(0)
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

  it('沙箱越界归 denied —— 对用户来说它就是「这台不让我读那儿」', () => {
    expect(classifyFileFailure('Path must stay inside the workspace sandbox root.')).toBe('denied')
    expect(classifyFileFailure(undefined)).toBe('failed')
  })

  it('修改时间是**绝对**时间,缺席就是缺席(不拿 1970 顶)', () => {
    const shown = formatMtime(Date.UTC(2026, 7, 31, 4, 5), 'zh')
    expect(shown).toContain('2026')
    expect(formatMtime(undefined, 'zh')).toBeNull()
    expect(formatMtime(0, 'zh')).toBeNull()
    expect(formatMtime(Number.NaN, 'zh')).toBeNull()
    // 换语言换的是年月日的次序与 12/24 小时制,不是「有没有这一格」。
    expect(formatMtime(Date.UTC(2026, 7, 31, 4, 5), 'en')).toContain('2026')
  })
})

describe('面包屑(投影,不是状态)', () => {
  it('逐段带上它自己的绝对路径 —— 点哪一段就回跳到哪儿', () => {
    expect(breadcrumbsOf('/a/b/c')).toEqual([
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' },
      { name: 'c', path: '/a/b/c' },
    ])
  })

  it('末尾斜杠不多产一段;根 `/` 与空根都没有可点的段', () => {
    expect(breadcrumbsOf('/a/b/')).toEqual([
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' },
    ])
    expect(breadcrumbsOf('/')).toEqual([])
    expect(breadcrumbsOf(null)).toEqual([])
  })

  it('拼回去逐字等于原路径 —— 屏幕上那条 textContent 因此不会说谎', () => {
    const root = '/Users/me/code/start-electron'
    expect(breadcrumbsOf(root).map((c) => `/${c.name}`).join('')).toBe(root)
  })
})

describe('回跳:navigateRoot', () => {
  it('把根挪到祖先段,拉那一层,并把来源翻成 manual', async () => {
    const port = fakePort()
    await useFilesSource.getState().setRoot(`${ROOT}/packages/core`)
    expect(useFilesSource.getState().rootOrigin).toBe('session')

    await useFilesSource.getState().navigateRoot(ROOT)
    expect(useFilesSource.getState().root).toBe(ROOT)
    // 既不是会话的目录也不是主目录 —— 那句「显示的是主目录」不能再说。
    expect(useFilesSource.getState().rootOrigin).toBe('manual')
    expect(port.listDirectory).toHaveBeenCalledWith(ROOT)
  })

  it('已经在那儿了就什么都不做(空路径同理)', async () => {
    const port = fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    const before = (port.listDirectory as ReturnType<typeof vi.fn>).mock.calls.length
    await useFilesSource.getState().navigateRoot(ROOT)
    await useFilesSource.getState().navigateRoot('')
    expect((port.listDirectory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
  })

  it('回跳之后会话真换了目录,照样能把用户拉回会话的根', async () => {
    fakePort()
    await useFilesSource.getState().setRoot(`${ROOT}/packages`)
    await useFilesSource.getState().navigateRoot(ROOT)
    await useFilesSource.getState().setRoot(`${ROOT}/docs`)
    expect(useFilesSource.getState().root).toBe(`${ROOT}/docs`)
    expect(useFilesSource.getState().rootOrigin).toBe('session')
  })
})

describe('详情:大小与时间只在这里问', () => {
  it('stat 一次,四格照抄;后端认出来的类型压过树上那一格', async () => {
    const port = fakePort({
      stat: vi.fn(async () => ({
        success: true,
        type: 'file' as const,
        path: `${ROOT}/a.ts`,
        size: 4096,
        mtimeMs: 1_700_000_000_000,
      })),
    })
    await useFilesSource
      .getState()
      .openDetail({ path: `${ROOT}/a.ts`, name: 'a.ts', type: 'directory' })
    expect(port.stat).toHaveBeenCalledWith(`${ROOT}/a.ts`)
    expect(currentFileDetail()).toEqual({
      path: `${ROOT}/a.ts`,
      name: 'a.ts',
      type: 'file',
      status: 'ready',
      size: 4096,
      mtimeMs: 1_700_000_000_000,
    })
  })

  it('后端没给大小 / 时间就是缺席,**不补 0**', async () => {
    fakePort({
      stat: vi.fn(async () => ({ success: true, type: 'directory' as const, path: ROOT })),
    })
    await useFilesSource.getState().openDetail({ path: ROOT, name: 'repo', type: 'directory' })
    const detail = currentFileDetail()
    expect(detail?.size).toBeUndefined()
    expect(detail?.mtimeMs).toBeUndefined()
  })

  it('读不到就归类 + 留原话(与树、预览共用同一条归类)', async () => {
    fakePort({
      stat: vi.fn(async () => ({ success: false, error: 'EACCES: permission denied, stat' })),
    })
    await useFilesSource.getState().openDetail({ path: ROOT, name: 'repo', type: 'directory' })
    expect(currentFileDetail()).toMatchObject({
      status: 'error',
      failure: 'denied',
      error: 'EACCES: permission denied, stat',
    })
  })

  it('关掉就没了', async () => {
    fakePort()
    await useFilesSource.getState().openDetail({ path: ROOT, name: 'repo', type: 'directory' })
    useFilesSource.getState().closeDetail()
    expect(currentFileDetail()).toBeNull()
  })

  /*
   * ── 竞速由键控吃掉(7d):`detailToken` 退役的反证 ────────────────────
   * 第一行的 stat 慢慢回来,而屏幕上问的已经是第二行 —— 慢的那一发只会落进
   * **它自己那一格**,改不到别人那一格。这是键控的性质,不是一格令牌记出来的。
   */
  it('开着第二行时第一行的 stat 才回来 —— 一个字都串不过去', async () => {
    const gate: Record<string, (value: { success: true; type: 'file'; path: string; size: number }) => void> = {}
    fakePort({
      stat: vi.fn(
        (path: string) =>
          new Promise((resolve) => {
            gate[path] = resolve as never
          }) as never,
      ),
    })
    /** 端口是 await 出来的,所以那一发 stat 要过一个微任务才真的发出去。 */
    const untilAsked = async (path: string) => {
      for (let i = 0; i < 50 && !gate[path]; i += 1) await Promise.resolve()
      if (!gate[path]) throw new Error(`没等到 stat(${path})`)
    }
    const first = `${ROOT}/first.ts`
    const second = `${ROOT}/second.ts`
    void useFilesSource.getState().openDetail({ path: first, name: 'first.ts', type: 'file' })
    await untilAsked(first)
    const running = useFilesSource.getState().openDetail({
      path: second,
      name: 'second.ts',
      type: 'file',
    })
    await untilAsked(second)
    // 慢的那一发(第一行)现在才回来。
    gate[first]({ success: true, type: 'file', path: first, size: 111 })
    gate[second]({ success: true, type: 'file', path: second, size: 222 })
    await running

    const shown = currentFileDetail()
    expect(shown?.path).toBe(second)
    expect(shown?.size).toBe(222)
  })

  it('再开一次同一行:上一次那四格留在屏上,不先退回「正在读取…」(律②)', async () => {
    fakePort({
      stat: vi.fn(async () => ({
        success: true,
        type: 'file' as const,
        path: `${ROOT}/a.ts`,
        size: 4096,
      })),
    })
    const target = { path: `${ROOT}/a.ts`, name: 'a.ts', type: 'file' as const }
    await useFilesSource.getState().openDetail(target)
    useFilesSource.getState().closeDetail()

    const running = useFilesSource.getState().openDetail(target)
    // 还在飞,但手上那四格已经在了 —— 屏幕上不出现 loading 那一档。
    expect(currentFileDetail()).toMatchObject({ status: 'ready', size: 4096 })
    await running
  })
})

describe('换空间:两族与本地态一起换掉', () => {
  it('旧空间那棵树一格都不许留下来', async () => {
    fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    await useFilesSource.getState().toggleDir(`${ROOT}/a.ts`)
    await useFilesSource.getState().openDetail({ path: ROOT, name: 'repo', type: 'directory' })
    expect(dirsQuery.keys().length).toBe(2)

    swapFilesForSpace('space-b', 'space-a')

    expect(dirsQuery.keys()).toEqual([])
    expect(detailQuery.keys()).toEqual([])
    expect(currentFileDetail()).toBeNull()
    expect(useFilesSource.getState().root).toBeNull()
    expect(useFilesSource.getState().expanded).toEqual({})
  })

  it('切回去时展开态回放照旧(家具账那一半一个字没动)', async () => {
    fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    await useFilesSource.getState().toggleDir(`${ROOT}/a.ts`)

    swapFilesForSpace('space-b', 'space-a')
    expect(useFilesSource.getState().expanded).toEqual({})
    swapFilesForSpace('space-a', 'space-b')
    expect(useFilesSource.getState().expanded).toEqual({ [`${ROOT}/a.ts`]: true })
  })

  it('中间那一步无害:本地态先落定(root 归 null = 空树),再清两族', async () => {
    fakePort()
    await useFilesSource.getState().setRoot(ROOT)
    /*
     * 「新账配旧树」那一帧的反证。**两头都要订**:换装现在动三处(本地态 + 两族),
     * 只订 store 的话次序反过来照样绿(族的 emit 不经过 store)—— 那就成了一条
     * 判不出东西的用例。所以这里把 store 与根那一格的每一次 emit 都记下来,
     * 逐个问同一句话:**这一刻摊出来的树是什么样**。
     *
     * 正确次序:先 set(root 归 null)→ 每一步都是「一棵还没有根的树」(0 行);
     * 反过来:先清族,那一步 root 还是旧的 → 摊出两条骨架短横,当场被这条抓住。
     */
    const seen: Array<{ root: string | null; rows: number }> = []
    const look = () => {
      const st = useFilesSource.getState()
      seen.push({
        root: st.root,
        rows: flattenTree(st.root, st.root ? { [st.root]: dirStateAt(st.root) } : {}, st.expanded)
          .length,
      })
    }
    const offStore = useFilesSource.subscribe(look)
    const offCell = dirsQuery.get(ROOT).subscribe(look)
    swapFilesForSpace('space-b', 'space-a')
    offStore()
    offCell()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((f) => f.root === null && f.rows === 0)).toBe(true)
  })
})
