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

  it('后端说不成功:候选清空,原话留着,不假装搜到了 0 条', async () => {
    answer = { success: false, files: [], error: 'File search must stay inside …' }
    await state().search('a', '/repo', 's1')
    expect(state()).toMatchObject({
      status: 'error',
      mentions: [],
      query: 'a',
      error: 'File search must stay inside …',
    })
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
