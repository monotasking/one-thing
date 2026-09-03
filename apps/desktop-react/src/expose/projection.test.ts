import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_ID } from '@shared/ipc/agents'
import type { SessionMeta } from '@shared/ipc/chat'
import {
  buildProjects,
  normalizeWorkingDirectory,
  projectNameOf,
  sessionAgentIdOf,
  sessionDigestOf,
  sessionKindOf,
  sessionMessageCountOf,
  sessionModelOf,
  toPreviewMessage,
  toSessionChapter,
  toSessionMarker,
  toSessionSummary,
} from './projection'
import {
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

  it('kind 六档:缺席读作 chat,room + dm 标记按**成员数**分 dm / swap', () => {
    const at = { id: 'a', name: 'a', createdAt: 0, updatedAt: 0 }
    expect(sessionKindOf(at)).toBe('chat')
    expect(sessionKindOf({ ...at, kind: 'room', room: { memberAgentIds: [] } })).toBe('room')
    // 单成员 = 人 ↔ agent;双成员 = agent ↔ agent(契约 RoomConfig.dm 那两句)。
    expect(sessionKindOf({ ...at, kind: 'room', room: { memberAgentIds: ['x'], dm: true } })).toBe('dm')
    expect(
      sessionKindOf({ ...at, kind: 'room', room: { memberAgentIds: ['x', 'y'], dm: true } }),
    ).toBe('swap')
    // 成员表缺席但打了 dm 标记:读作 dm(0 ≠ 2)—— 不去猜一个不存在的第二位。
    expect(sessionKindOf({ ...at, kind: 'room', room: { dm: true } as never })).toBe('dm')
    expect(sessionKindOf({ ...at, kind: 'work' })).toBe('work')
  })

  /**
   * 方向 A 新增的两格。判据各自不同,所以分两条:
   *  · 置顶:缺席读作 **false**(「没置顶」是真状态,不是缺失的事实);
   *  · 父房间:`collab.roomSessionId` 原样搬,缺席读作 null。
   */
  it('isPinned 缺席读作 false,不是 null / undefined', () => {
    const bare: SessionMeta = { id: 'x', name: 'x', createdAt: 0, updatedAt: 0 }
    expect(toSessionSummary(bare).isPinned).toBe(false)
    expect(toSessionSummary({ ...bare, isPinned: true }).isPinned).toBe(true)
    expect(toSessionSummary({ ...bare, isPinned: false }).isPinned).toBe(false)
    expect(SESSIONS.find((s) => s.id === 'os-toolkit')!.isPinned).toBe(true)
    expect(SESSIONS.find((s) => s.id === 'os-provider')!.isPinned).toBe(false)
  })

  it('roomId 就是 collab.roomSessionId;缺席读作 null', () => {
    const bare: SessionMeta = { id: 'x', name: 'x', createdAt: 0, updatedAt: 0 }
    expect(toSessionSummary(bare).roomId).toBeNull()
    expect(
      toSessionSummary({ ...bare, kind: 'work', collab: { roomSessionId: 'rm-1' } }).roomId,
    ).toBe('rm-1')
    expect(SESSIONS.find((s) => s.id === 'wk-verify')!.roomId).toBe('rm-release')
    expect(SESSIONS.find((s) => s.id === 'lo-notes')!.roomId).toBeNull()
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

/*
 * 09-04 P2:`buildGroups` 与它那批「组的次序 / 空组不出现 / 合成组名走字典」的
 * 用例随分组一起退役 —— 分组不再是投影的事(列表模型是 `list-model.buildListModel`,
 * 一次只按时间分组)。**投影这一层剩下的分组事实只有一件**:侧栏那份项目名册。
 * 那几条断言没有被删掉,是被搬到了它们今天真正的产地:
 * 「协作与项目互斥」在 `scopes.test.ts`(SCOPE_SPECS 的 predicate),
 * 「归属互斥且完备 / 次序 / 空节不出现」在 `list-model.test.ts`。
 */
describe('项目名册(侧栏那一列的产地)', () => {
  it('项目按「组内最近一条会话」倒序 —— 最近在动的排前面', () => {
    expect(PROJECTS.map((p) => p.id)).toEqual([ONETHING_DIR, TRANSREADER_DIR])
    expect(PROJECTS[0].name).toBe('start-electron')
  })

  it('协作形态不开项目:带着工作目录的房间不会在名册里长出一格', () => {
    const room = SESSIONS.find((s) => s.id === 'rm-release')!
    expect(room.projectId).toBe(ONETHING_DIR)
    expect(buildProjects([room])).toEqual([])
  })

  it('末尾斜杠归一真的生效:两条目录只差一个斜杠的会话落在同一格项目上', () => {
    const sameDir = SESSIONS.filter((s) => s.projectId === ONETHING_DIR).map((s) => s.id)
    expect(sameDir).toContain('os-expose') // 它的 workingDirectory 带末尾斜杠
    expect(buildProjects(SESSIONS).filter((p) => p.id === ONETHING_DIR)).toHaveLength(1)
  })

  it('一条会话都没有就没有项目', () => {
    expect(buildProjects([])).toEqual([])
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

/**
 * F 批新增的两格。判据都是「没有产地就是 null」,不给默认值 ——
 * 一个永远显示某个模型名 / 永远挂着 default 的徽,和 D1 删掉的那批假徽是同一种病。
 */
describe('模型 / agent 两格的产地', () => {
  it('lastModel 原样搬,空串与缺席都读作 null', () => {
    expect(sessionModelOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, lastModel: 'gpt-5.5' })).toBe('gpt-5.5')
    expect(sessionModelOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, lastModel: '  ' })).toBeNull()
    expect(sessionModelOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0 })).toBeNull()
  })

  it("agentId 非 default 才算一格;'default' 与缺席都读作 null", () => {
    expect(sessionAgentIdOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, agentId: 'reviewer' })).toBe('reviewer')
    expect(sessionAgentIdOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, agentId: DEFAULT_AGENT_ID })).toBeNull()
    expect(sessionAgentIdOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0 })).toBeNull()
  })

  it('两格都进 SessionSummary(卡面与 Quick Look 读的是同一份投影)', () => {
    const summary = SESSIONS.find((s) => s.id === 'os-provider')!
    expect(summary.model).toBe('claude-opus-5')
    expect(summary.agentId).toBe('reviewer')
    expect(SESSIONS.find((s) => s.id === 'os-compact')!.agentId).toBeNull()
    expect(SESSIONS.find((s) => s.id === 'lo-notes')!.model).toBeNull()
  })
})

/**
 * H 批新增的两格,判据仍然是那一句「没有产地就不画」—— 但两格对「缺席」的定义
 * 不一样,这批用例钉的正是这个差别:
 *  - 摘要:空串与缺席都是缺席(一行空文字在屏幕上与不画没有区别,却占一行高);
 *  - 条数:**只有缺席才是缺席**,0 是真值(一条真的空会话就该说自己是 0 条)。
 */
const bare = { id: 'a', name: 'a', createdAt: 0, updatedAt: 0 } satisfies SessionMeta

describe('摘要 / 消息数两格的产地', () => {
  it('lastMessagePreview 原样搬(只去首尾空白),空串与缺席都读作 null', () => {
    expect(sessionDigestOf({ ...bare, lastMessagePreview: '  最近说到这儿  ' })).toBe('最近说到这儿')
    expect(sessionDigestOf({ ...bare, lastMessagePreview: '   ' })).toBeNull()
    expect(sessionDigestOf(bare)).toBeNull()
  })

  it('messageCount:0 是真值,只有缺席才读作 null', () => {
    expect(sessionMessageCountOf({ ...bare, messageCount: 0 })).toBe(0)
    expect(sessionMessageCountOf({ ...bare, messageCount: 42 })).toBe(42)
    expect(sessionMessageCountOf(bare)).toBeNull()
  })

  it('画不出来的数(负数 / NaN)当没算过 —— 不把它当成 0 画出去', () => {
    expect(sessionMessageCountOf({ ...bare, messageCount: -1 })).toBeNull()
    expect(sessionMessageCountOf({ ...bare, messageCount: Number.NaN })).toBeNull()
    expect(sessionMessageCountOf({ ...bare, messageCount: 3.7 })).toBe(3)
  })

  it('两格都进 SessionSummary;存量老会话(两格都没有)诚实地是两个 null', () => {
    const summary = SESSIONS.find((s) => s.id === 'os-provider')!
    expect(summary.digest).toBe('那就把三处读取点合成同一个判定函数')
    expect(summary.messageCount).toBe(42)
    // 摘要与条数各自独立:这一条只有条数,没有摘要。
    expect(SESSIONS.find((s) => s.id === 'os-compact')!.digest).toBeNull()
    expect(SESSIONS.find((s) => s.id === 'os-compact')!.messageCount).toBe(1)
    // 两格都缺席的老会话。
    const old = SESSIONS.find((s) => s.id === 'lo-notes')!
    expect(old.digest).toBeNull()
    expect(old.messageCount).toBeNull()
  })

  it('摘要与 preview 是并列的两格,不是同一件事的两个名字', () => {
    const meta = SESSION_META.find((m) => m.id === 'os-provider')!
    const summary = toSessionSummary(meta)
    expect(summary.preview).toBe(meta.previewText)
    expect(summary.digest).toBe(meta.lastMessagePreview)
    expect(summary.preview).not.toBe(summary.digest)
  })
})

/*
 * ── 「列表投影过滤」那一组 09-04 退役 ──────────────────────────────────────
 * 08-31 那张「只保留私聊和普通聊天」的名单(`isListedSession`)随方向 A 一起删:
 * 层级铺开之后没有一档需要被藏。谁站顶层、谁当子行由 `list-model.ts` 说了算,
 * 它自己那一组用例(`list-model.test.ts` 的 attachChildren 四条)守着这件事。
 */
