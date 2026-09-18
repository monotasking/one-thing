import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FilesListRequest, FilesListResponse } from '@shared/ipc/files'
import { configureFilesPort } from './files-port'
import {
  FILE_MENTION_LIMIT,
  relativeLabel,
  toFileMentions,
  useFileMentionsSource,
} from './file-mentions-source'
import { sessionCwdOf } from './files-source'
import type { SessionSummary } from '../expose/types'

/**
 * `@` 引用的候选(D3 波二)。这一层验的是**判据与取数**:词怎么传、cwd 怎么定、
 * 一行怎么念、竞速谁作数。去抖是「人打字的节奏」,归组件那一层
 * (Composer.test.tsx),所以这里一个假计时器都不用。
 */

const asked: FilesListRequest[] = []
let answer: FilesListResponse = { success: true, files: [], entries: [] }
/** 下一发挂住不答(验竞速用);挂住那一发的 resolve 落在 `release` 上。 */
let holdNext = false
let release: ((response: FilesListResponse) => void) | null = null

/** 让在飞的 promise 链走完一轮(端口本身是惰性 import,不止一个微任务)。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  asked.length = 0
  answer = { success: true, files: [], entries: [] }
  holdNext = false
  release = null
  useFileMentionsSource.getState().reset()
  configureFilesPort({
    ready: async () => undefined,
    listDirectory: async () => ({ success: false, error: 'not used here' }),
    stat: async () => ({ success: false, error: 'not used here' }),
    readContent: async () => ({ success: false, error: 'not used here' }),
    saveContent: async () => ({ success: true }),
    reveal: async () => ({ success: false, error: 'not used here' }),
    list: async (request) => {
      asked.push(request)
      if (holdNext) {
        holdNext = false
        return new Promise<FilesListResponse>((resolve) => {
          release = resolve
        })
      }
      return answer
    },
  })
})

afterEach(() => {
  configureFilesPort(undefined)
  useFileMentionsSource.getState().reset()
})

const state = () => useFileMentionsSource.getState()

describe('一行候选怎么念', () => {
  it('cwd 之下念相对路径 —— 那是人心里的名字', () => {
    expect(relativeLabel('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    // 结尾那道斜杠不该多切一个字符。
    expect(relativeLabel('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
  })

  it('不在 cwd 之下念**整条路径**,不砍成文件名', () => {
    // 桌面那侧同时搜下载目录 / 笔记根 —— 砍成文件名会让两个 a.ts 长得一模一样。
    expect(relativeLabel('/Users/me/Downloads/a.ts', '/repo')).toBe('/Users/me/Downloads/a.ts')
    expect(relativeLabel('/repo-other/a.ts', '/repo')).toBe('/repo-other/a.ts')
  })

  it('没有 cwd 就整条路径 —— 相对于谁都不知道,不能编一个根', () => {
    expect(relativeLabel('/repo/src/a.ts', null)).toBe('/repo/src/a.ts')
  })
})

describe('线上形状 → 屏幕形状', () => {
  it('优先吃 entries(带类型那一份);缺席才退回 files 纯路径表', () => {
    expect(
      toFileMentions(
        { success: true, files: ['/repo/x'], entries: [{ path: '/repo/dir', type: 'directory' }] },
        '/repo',
      ),
    ).toEqual([{ path: '/repo/dir', label: 'dir', type: 'directory' }])

    expect(toFileMentions({ success: true, files: ['/repo/x.ts'] }, '/repo')).toEqual([
      { path: '/repo/x.ts', label: 'x.ts', type: 'file' },
    ])
  })

  /*
   * 08-31 真机走查:敲下 `@`,候选第二行是 `/Users/yitiansong/Downloads`。
   * 那是后端语义 —— `files.list` 把 cwd、笔记根、接入目录、下载目录**并列**当搜索根
   * (runtime/src/files/file-search.ts 的 resolveOnethingFileSearchRoots),给了 cwd
   * 也照并。人在一条会话里敲 `@` 问的是「这个项目里的哪个文件」,所以壳这一层筛。
   */
  it('有工作目录时,根外的候选一条都不出(下载目录 / 笔记根 / 别的项目)', () => {
    const response: FilesListResponse = {
      success: true,
      files: [],
      entries: [
        { path: '/repo', type: 'directory' },
        { path: '/repo/src/a.ts', type: 'file' },
        { path: '/Users/me/Downloads', type: 'directory' },
        { path: '/Users/me/Downloads/a.ts', type: 'file' },
        { path: '/Users/me/note/b.md', type: 'file' },
        // 前缀像但不是:`/repo-other` 不在 `/repo` 名下(尾斜杠正是为这一条)。
        { path: '/repo-other/c.ts', type: 'file' },
      ],
    }
    expect(toFileMentions(response, '/repo').map((mention) => mention.path)).toEqual([
      '/repo',
      '/repo/src/a.ts',
    ])
  })

  it('工作目录**自己**留着 —— 要挡的是别的根,不是这条会话的项目', () => {
    const response: FilesListResponse = {
      success: true,
      files: [],
      entries: [{ path: '/repo', type: 'directory' }],
    }
    expect(toFileMentions(response, '/repo/')).toHaveLength(1)
  })

  it('没有工作目录时一条不筛 —— 那是「按宿主自己的搜索根找」的既有裁定', () => {
    const response: FilesListResponse = {
      success: true,
      files: [],
      entries: [
        { path: '/Users/me/Downloads/a.ts', type: 'file' },
        { path: '/repo/src/a.ts', type: 'file' },
      ],
    }
    expect(toFileMentions(response, null)).toHaveLength(2)
  })
})

describe('取数', () => {
  it('词原样透传给后端(已 trim),并带上限与会话', async () => {
    await state().search('  cap  ', '/repo', 'session-1')
    expect(asked).toEqual([
      { cwd: '/repo', query: 'cap', limit: FILE_MENTION_LIMIT, sessionId: 'session-1' },
    ])
  })

  it('cwd 拿不到就**不带这一格** —— 不在渲染层拼一个 ~ 去顶', async () => {
    await state().search('cap', null, '')
    expect(asked).toEqual([{ query: 'cap', limit: FILE_MENTION_LIMIT }])
  })

  it('cwd 的产地是会话的工作目录(files 面立的那条唯一写法)', async () => {
    const sessions = [
      { id: 's1', projectId: '/repo' },
      { id: 's2', projectId: null },
    ] as unknown as SessionSummary[]

    await state().search('a', sessionCwdOf(sessions, 's1'), 's1')
    await state().search('a', sessionCwdOf(sessions, 's2'), 's2')
    // 没选会话 = 没有根,与「这条会话没有工作目录」是同一种缺席。
    await state().search('a', sessionCwdOf(sessions, ''), '')

    expect(asked.map((request) => request.cwd)).toEqual(['/repo', undefined, undefined])
  })

  it('空词照样发 —— 刚敲下 @ 就该出一批,那不是「清空」', async () => {
    answer = { success: true, files: [], entries: [{ path: '/repo/a.ts', type: 'file' }] }
    await state().search('', '/repo', 's1')
    expect(asked[0].query).toBe('')
    expect(state().mentions).toEqual([{ path: '/repo/a.ts', label: 'a.ts', type: 'file' }])
  })

  /*
   * 7c 批的规范修正:失败**不清候选**(律②)。
   * 从前这里是 `mentions: []` —— 一次抖动的失败会把人刚看见的一屏候选抹掉,
   * 下一次击键又把它拉回来,正是律②说的那种「闪」。现在错误与旧答案并陈。
   */
  it('后端说不成功:原话留着,**旧候选不清** —— 不假装搜到了 0 条,也不抹掉上一屏', async () => {
    answer = { success: true, files: [], entries: [{ path: '/repo/a.ts', type: 'file' }] }
    await state().search('a', '/repo', 's1')
    expect(state().mentions).toHaveLength(1)

    answer = { success: false, files: [], error: 'File search must stay inside …' }
    await state().search('ab', '/repo', 's1')
    expect(state()).toMatchObject({
      status: 'error',
      error: 'File search must stay inside …',
    })
    // 旧候选还在屏上,而 `query` 仍念着**产生它**的那个词(不是这一发的 'ab')。
    expect(state().mentions).toEqual([{ path: '/repo/a.ts', label: 'a.ts', type: 'file' }])
    expect(state().query).toBe('a')
  })

  it('端口抛了也走同一条路:落进 error,而不是没人接的 rejection + 永远 loading', async () => {
    answer = { success: true, files: [], entries: [{ path: '/repo/a.ts', type: 'file' }] }
    await state().search('a', '/repo', 's1')

    configureFilesPort({
      ready: async () => undefined,
      listDirectory: async () => ({ success: false, error: 'x' }),
      stat: async () => ({ success: false, error: 'x' }),
      readContent: async () => ({ success: false, error: 'x' }),
      saveContent: async () => ({ success: true }),
      reveal: async () => ({ success: false, error: 'x' }),
      list: async () => {
        throw new Error('传输面断了')
      },
    })
    await expect(state().search('ab', '/repo', 's1')).resolves.toBeUndefined()
    expect(state().status).toBe('error')
    expect(state().error).toBe('传输面断了')
    expect(state().mentions).toHaveLength(1)
  })

  it('竞速:先发的那一发回来晚了也不作数(去抖窗口里词已经变了)', async () => {
    holdNext = true
    const first = state().search('slow', '/repo', 's1')
    await settle()

    answer = { success: true, files: [], entries: [{ path: '/repo/fast.ts', type: 'file' }] }
    await state().search('fast', '/repo', 's1')
    expect(state().query).toBe('fast')

    release?.({ success: true, files: [], entries: [{ path: '/repo/slow.ts', type: 'file' }] })
    await first
    // 迟到的那一发一个字都没改屏幕。
    expect(state().query).toBe('fast')
    expect(state().mentions).toEqual([{ path: '/repo/fast.ts', label: 'fast.ts', type: 'file' }])
  })
})

/*
 * 点名根(09-18,正本 `docs/composer-open-dir-mentions-2026-09.md` §2.2 / §2.4):
 * 工作目录 + 此刻开着的目录。后端只在这些根里找、每条带回它的根,于是这一层不再筛。
 */
describe('点名根', () => {
  const roots = [
    { path: '/repo', primary: true },
    { path: '/far/docs', primary: false },
  ]

  it('请求带上根表(工作目录在第一格),cwd 照旧带着', async () => {
    await state().search('a', '/repo', 's1', roots)
    expect(asked).toEqual([
      { cwd: '/repo', query: 'a', limit: FILE_MENTION_LIMIT, sessionId: 's1', roots: ['/repo', '/far/docs'] },
    ])
  })

  it('空根表 = 老口径逐字节不变(请求不带这一格)', async () => {
    await state().search('a', '/repo', 's1', [])
    expect(asked).toEqual([{ cwd: '/repo', query: 'a', limit: FILE_MENTION_LIMIT, sessionId: 's1' }])
  })

  it('标签按条目自己的根念;只有不是工作目录的那几条记出处;不再按工作目录筛', () => {
    const response: FilesListResponse = {
      success: true,
      files: [],
      entries: [
        { path: '/repo/src/a.ts', type: 'file', source: 'picked', root: '/repo' },
        { path: '/far/docs', type: 'directory', source: 'picked', root: '/far/docs' },
        { path: '/far/docs/guide/a.md', type: 'file', source: 'picked', root: '/far/docs' },
      ],
    }
    expect(toFileMentions(response, '/repo', roots)).toEqual([
      { path: '/repo/src/a.ts', label: 'src/a.ts', type: 'file' },
      { path: '/far/docs', label: '/far/docs', type: 'directory', root: '/far/docs' },
      { path: '/far/docs/guide/a.md', label: 'guide/a.md', type: 'file', root: '/far/docs' },
    ])
  })

  it('老宿主不报根:按路径认领,哪个点名根都不落的丢掉(笔记根 / 下载目录不许漏进来)', () => {
    const response: FilesListResponse = {
      success: true,
      files: [],
      entries: [
        { path: '/repo/a.ts', type: 'file', source: 'workdir' },
        { path: '/Users/me/Downloads/x.pdf', type: 'file', source: 'downloads' },
        { path: '/far/docs/b.md', type: 'file' },
      ],
    }
    expect(toFileMentions(response, '/repo', roots)).toEqual([
      { path: '/repo/a.ts', label: 'a.ts', type: 'file' },
      { path: '/far/docs/b.md', label: 'b.md', type: 'file', root: '/far/docs' },
    ])
  })
})
