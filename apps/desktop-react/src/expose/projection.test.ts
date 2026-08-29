import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/ipc/chat'
import {
  buildGroups,
  buildProjects,
  normalizeWorkingDirectory,
  projectNameOf,
  sessionKindOf,
  toPreviewMessage,
  toSessionChapter,
  toSessionMarker,
  toSessionSummary,
} from './projection'
import {
  GROUPS,
  ONETHING_DIR,
  PROJECTS,
  SESSIONS,
  SESSION_META,
  TRANSREADER_DIR,
} from '../data/__fixtures__/sessions'

/**
 * 投影层是「后端字段 → 卡面一格」的唯一产地,所以这批用例钉的是**映射本身**:
 * 哪一格来自哪一个字段、哪一格没有产地因此不存在、分组的归属规则是什么。
 */

describe('SessionMeta → SessionSummary', () => {
  it('逐格照抄,不编:标题=name、预览=previewText、时间=updatedAt', () => {
    const [first] = SESSIONS
    expect(first.id).toBe('os-provider')
    expect(first.title).toBe('重构 provider 抽象')
    expect(first.preview).toBe('把 provider 的能力判定收敛到一处')
    expect(first.updatedAt).toBe(SESSION_META[0].updatedAt)
  })

  it('没有 previewText 的会话拿到空串,而不是一句占位文案', () => {
    const bare: SessionMeta = { id: 'x', name: 'x', createdAt: 0, updatedAt: 0 }
    expect(toSessionSummary(bare).preview).toBe('')
    expect(toSessionSummary(bare).projectId).toBeNull()
  })

  it('kind 五档:缺席读作 chat,room + dm 标记读作 dm', () => {
    expect(sessionKindOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0 })).toBe('chat')
    expect(
      sessionKindOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, kind: 'room', room: { memberAgentIds: [] } }),
    ).toBe('room')
    expect(
      sessionKindOf({
        id: 'a', name: 'a', createdAt: 0, updatedAt: 0,
        kind: 'room', room: { memberAgentIds: [], dm: true },
      }),
    ).toBe('dm')
    expect(sessionKindOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, kind: 'work' })).toBe('work')
  })
})

describe('工作目录归一与项目名', () => {
  it('末尾斜杠不算另一个目录', () => {
    expect(normalizeWorkingDirectory('/a/b/')).toBe('/a/b')
    expect(normalizeWorkingDirectory('/a/b')).toBe('/a/b')
  })

  it('空 / 全空白 = 不属于任何项目', () => {
    expect(normalizeWorkingDirectory(undefined)).toBeNull()
    expect(normalizeWorkingDirectory('   ')).toBeNull()
  })

  it('项目名是路径末段', () => {
    expect(projectNameOf('/Users/dev/code/start-electron')).toBe('start-electron')
    expect(projectNameOf('/')).toBe('/')
  })
})

describe('分组', () => {
  it('项目按「组内最近一条会话」倒序 —— 最近在动的排前面', () => {
    expect(PROJECTS.map((p) => p.id)).toEqual([ONETHING_DIR, TRANSREADER_DIR])
    expect(PROJECTS[0].name).toBe('start-electron')
  })

  it('归属互斥且完备:每条会话恰好落在一个组里', () => {
    const ids = GROUPS.flatMap((g) => g.sessions.map((s) => s.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(SESSIONS.map((s) => s.id).sort())
  })

  it('协作形态优先于项目归属:带着工作目录的房间也进协作组', () => {
    const room = SESSIONS.find((s) => s.id === 'rm-release')!
    expect(room.projectId).toBe(ONETHING_DIR)
    expect(GROUPS.find((g) => g.id === ONETHING_DIR)!.sessions.map((s) => s.id)).not.toContain(
      'rm-release',
    )
    expect(GROUPS.find((g) => g.id === 'collab')!.sessions.map((s) => s.id)).toContain('rm-release')
  })

  it('组的次序 = 项目组 → 协作 → 独立', () => {
    expect(GROUPS.map((g) => g.id)).toEqual([ONETHING_DIR, TRANSREADER_DIR, 'collab', 'loose'])
  })

  it('末尾斜杠的那条和别的会话在同一组(归一真的生效了)', () => {
    expect(GROUPS[0].sessions.map((s) => s.id)).toEqual([
      'os-provider',
      'os-compact',
      'os-expose',
      'os-toolkit',
    ])
  })

  it('空组不出现:一条会话都没有的分区在总览上没有任何可看的东西', () => {
    expect(buildGroups(buildProjects([]), [])).toEqual([])
    const onlyLoose = SESSIONS.filter((s) => s.id === 'lo-notes')
    expect(buildGroups(buildProjects(onlyLoose), onlyLoose).map((g) => g.id)).toEqual(['loose'])
  })

  it('合成组的名字走字典(nameKey),项目组的名字是数据(name)', () => {
    const collab = GROUPS.find((g) => g.id === 'collab')!
    expect(collab.nameKey).toBe('expose.groupCollab')
    expect(collab.name).toBeUndefined()
    expect(GROUPS[0].name).toBe('start-electron')
    expect(GROUPS[0].nameKey).toBeUndefined()
  })
})

describe('会话内部的两份按需数据', () => {
  it('章节 kind 如实转述,不合并成一种', () => {
    const chapter = toSessionChapter({
      id: 's1', origin: 'inferred', kind: 'question', title: 't', detail: 'd',
      files: [], startedAt: 0, turnCount: 1, revision: 0, startMessageId: 'm1',
    })
    expect(chapter).toEqual({ id: 's1', title: 't', detail: 'd', kind: 'question', startMessageId: 'm1' })
  })

  it('预览消息只取 role + content;不认识的 role 折成 error', () => {
    expect(toPreviewMessage({ id: 'm', role: 'assistant', content: 'hi', timestamp: 0 })).toEqual({
      id: 'm', role: 'assistant', text: 'hi',
    })
    expect(toPreviewMessage({ id: 'm', role: 'error', content: '', timestamp: 0 })).toEqual({
      id: 'm', role: 'error', text: '',
    })
  })

  it('用户锚点只留 id 与预览 —— 键上要的就这两样', () => {
    expect(toSessionMarker({ id: 'm1', seq: 3, timestamp: 9, preview: '你好' })).toEqual({
      id: 'm1', preview: '你好',
    })
  })
})
