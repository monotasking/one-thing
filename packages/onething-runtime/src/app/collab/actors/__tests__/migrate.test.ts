/**
 * 迁移器带 IO 的那一半(D5):幂等、备份、零写盘、不碰 `sessions/`。
 *
 * 这个文件里最重要的两条断言不是「迁对了」,是**「没迁的东西一个字节都没动」**:
 * 迁移是一趟单向门,而门后面站着这个产品里最贵的数据(会话)。所以 dry-run 与
 * 执行都各拍一次全店快照,逐文件比。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../../session/testing/facade-mock.js'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-collab-migrate-'))
const storeRootRef = { value: storeRoot }
// P0.2 ③:被测模块改走 `sessionReads` / `sessionCommands`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。换成共用替身,只留
// 这个用例真正需要的那一口。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))
vi.mock('../../../session/commands.js', () => import('../../../session/testing/facade-mock.js'))
bindSessionFacadeMock({
  getSession: () => undefined,
  readTranscript: (id: string) => {
    try { return fs.readFileSync(path.join(storeRootRef.value, 'sessions', id, 'messages.jsonl'), 'utf-8') } catch { return undefined }
  },
})

vi.mock('../../../stores/paths.js', () => ({
  getStorePath: () => storeRootRef.value,
  getSessionsDir: () => path.join(storeRootRef.value, 'sessions'),
}))

const {
  collabV2BackupDir,
  collabV3MigrationMarkerPath,
  migrateCollabToV3,
  readCollabV3MigrationMarker,
} = await import('../migrate.js')
const { collabAgentAccountPath, collabAgentActorDir } = await import('../agent-mailbox.js')
const { collabRoomAccountPath, createCollabRoomAccountFileStore } = await import('../room-account.js')
const { createCollabRoomAccount } = await import('@onething/runtime/collab/actors')
const { readActorMailboxLog } = await import('@onething/core/actors')

afterAll(() => {
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const ROOM = 'room-alpha'
const IRIS = 'iris'
const BRAM = 'bram'
const NOW = Date.parse('2026-08-03T12:34:56.000Z')

/* ── 造一份 v2 的店 ────────────────────────────────────────────────────── */

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function messagesJsonl(sessionId: string, messages: readonly unknown[]): string {
  let text = `${JSON.stringify({ t: 'h', v: 2, sessionId })}\n`
  messages.forEach((message, index) => {
    text += `${JSON.stringify({ t: 'm', seq: index + 1, m: message })}\n`
  })
  return text
}

function seedRoomSession(roomId: string, options: {
  memberAgentIds: string[]
  messages: Array<{ id: string; role?: string; content?: string; timestamp?: number; agentId?: string }>
}): void {
  const dir = path.join(storeRoot, 'sessions', roomId)
  writeJson(path.join(dir, 'meta.json'), {
    id: roomId,
    kind: 'room',
    name: '产品房',
    room: { memberAgentIds: options.memberAgentIds },
  })
  const messages = options.messages.map((message, index) => ({
    role: 'user',
    content: `内容 ${message.id}`,
    timestamp: 1_000 + index,
    ...message,
  }))
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), messagesJsonl(roomId, messages), 'utf-8')
}

function seedExecSession(agentId: string, roomId: string, seenMessageId?: string): void {
  const sessionId = `agent-exec-${agentId}-${roomId}`
  writeJson(path.join(storeRoot, 'sessions', sessionId, 'meta.json'), {
    id: sessionId,
    kind: 'agent',
    isArchived: true,
    collab: { roomSessionId: roomId, ...(seenMessageId ? { seenMessageId, seenAt: 1_500 } : {}) },
  })
  fs.writeFileSync(
    path.join(storeRoot, 'sessions', sessionId, 'messages.jsonl'),
    messagesJsonl(sessionId, []),
    'utf-8',
  )
}

function seedV2Room(roomId: string, state: unknown, board: unknown = { version: 1, cards: [] }): void {
  writeJson(path.join(storeRoot, 'collab', roomId, 'state.json'), state)
  if (board !== null) writeJson(path.join(storeRoot, 'collab', roomId, 'board.json'), board)
}

/** 一份典型的店:一间房、两位同事、一位有游标一位没有。 */
function seedTypicalStore(): void {
  seedRoomSession(ROOM, {
    memberAgentIds: [IRIS, BRAM],
    messages: [
      { id: 'm1' },
      { id: 'm2' },
      { id: 'm3', role: 'assistant', agentId: IRIS },
      { id: 'm4', role: 'assistant', agentId: BRAM },
      { id: 'm5' },
    ],
  })
  seedExecSession(IRIS, ROOM, 'm2')
  seedExecSession(BRAM, ROOM)
  seedV2Room(ROOM, {
    version: 1,
    lastProcessedMessageId: 'm4',
    lastProcessedAt: 4_000,
    chainCount: 3,
    floorEpoch: 7,
    activations: [{ id: 'a1' }],
  })
}

/* ── 全店快照 ──────────────────────────────────────────────────────────── */

function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>()
  if (!fs.existsSync(root)) return files
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.set(path.relative(root, full), fs.readFileSync(full, 'utf-8'))
    }
  }
  walk(root)
  return files
}

beforeEach(() => {
  fs.rmSync(storeRoot, { recursive: true, force: true })
  fs.mkdirSync(storeRoot, { recursive: true })
  storeRootRef.value = storeRoot
})

/* ── dry-run ───────────────────────────────────────────────────────────── */

describe('dry-run', () => {
  it('一个字节都不写,报告却是完整的', async () => {
    seedTypicalStore()
    const before = snapshot(storeRoot)

    const report = await migrateCollabToV3({ dryRun: true, now: () => NOW })

    expect(snapshot(storeRoot)).toEqual(before)
    expect(fs.existsSync(collabV3MigrationMarkerPath())).toBe(false)
    expect(fs.existsSync(collabRoomAccountPath(ROOM))).toBe(false)
    expect(fs.existsSync(path.join(storeRoot, 'agents-v3'))).toBe(false)
    expect(fs.existsSync(path.join(storeRoot, 'backup'))).toBe(false)

    expect(report.dryRun).toBe(true)
    expect(report.backupDir).toBeUndefined()
    expect(report.rooms).toHaveLength(1)
    expect(report.rooms[0].status).toBe('migrated')
    expect(report.totals.agentPairs).toBe(2)
    expect(report.totals.backfilled).toBe(2) // iris:m4/m5(m3 是它自己说的)
  })

  it('默认档就是 dry-run —— 单向门不该靠调用方记得传参数', async () => {
    seedTypicalStore()
    const before = snapshot(storeRoot)
    const report = await migrateCollabToV3({ now: () => NOW })
    expect(report.dryRun).toBe(true)
    expect(snapshot(storeRoot)).toEqual(before)
  })

  it('dry-run 与执行算出来的是同一份计划', async () => {
    seedTypicalStore()
    const planned = await migrateCollabToV3({ dryRun: true, now: () => NOW })
    const executed = await migrateCollabToV3({ dryRun: false, now: () => NOW })
    expect(executed.rooms).toEqual(planned.rooms)
    expect(executed.totals).toEqual(planned.totals)
  })
})

/* ── 执行 ──────────────────────────────────────────────────────────────── */

describe('执行', () => {
  it('房间账落在 actors/room.json,水位/代数/链计数都对', async () => {
    seedTypicalStore()
    await migrateCollabToV3({ dryRun: false, now: () => NOW })

    const account = createCollabRoomAccountFileStore().load(ROOM)
    expect(account.watermark).toEqual({ messageId: 'm4', at: 4_000 })
    expect(account.floor.epoch).toBe(7)
    expect(account.chainCount).toBe(3)
    // v2 的账原样留着 —— v3 并存,D6 切换后它自然失效。
    expect(fs.existsSync(path.join(storeRoot, 'collab', ROOM, 'state.json'))).toBe(true)
  })

  it('agent 账拿到两个水位,信箱拿到未读尾巴', async () => {
    seedTypicalStore()
    await migrateCollabToV3({ dryRun: false, now: () => NOW })

    const iris = JSON.parse(fs.readFileSync(collabAgentAccountPath(IRIS), 'utf-8')) as {
      rooms: Record<string, { readMessageId?: string; deliveredMessageId?: string; turns: number }>
    }
    expect(iris.rooms[ROOM].readMessageId).toBe('m2')
    expect(iris.rooms[ROOM].deliveredMessageId).toBe('m2')
    expect(iris.rooms[ROOM].turns).toBe(1)

    const log = await readActorMailboxLog(path.join(collabAgentActorDir(IRIS), 'inbox.jsonl'))
    // m3 是 iris 自己说的 —— 不回声给它;m4/m5 才是它错过的。
    expect(log.map(event => event.id)).toEqual([`evt:${ROOM}:m4`, `evt:${ROOM}:m5`])

    // 没有游标的同事:账有这一格(它在册),但信箱是空的。
    const bram = JSON.parse(fs.readFileSync(collabAgentAccountPath(BRAM), 'utf-8')) as {
      rooms: Record<string, { readMessageId?: string }>
    }
    expect(bram.rooms[ROOM]).toBeDefined()
    expect(bram.rooms[ROOM].readMessageId).toBeUndefined()
    expect(await readActorMailboxLog(path.join(collabAgentActorDir(BRAM), 'inbox.jsonl'))).toEqual([])
  })

  it('notebook.md 不存在就不建 —— 首写时才建', async () => {
    seedTypicalStore()
    await migrateCollabToV3({ dryRun: false, now: () => NOW })
    expect(fs.existsSync(path.join(collabAgentActorDir(IRIS), 'notebook.md'))).toBe(false)
  })

  it('曾在册(已被移出成员表但执行会话还在)也迁', async () => {
    seedRoomSession(ROOM, { memberAgentIds: [IRIS], messages: [{ id: 'm1' }, { id: 'm2' }] })
    seedExecSession(IRIS, ROOM, 'm1')
    seedExecSession('ghost', ROOM, 'm1')
    seedV2Room(ROOM, { version: 1, chainCount: 0, floorEpoch: 1 })

    const report = await migrateCollabToV3({ dryRun: false, now: () => NOW })
    expect(report.rooms[0].agents.map(agent => agent.agentId).sort()).toEqual(['ghost', 'iris'])
    expect(fs.existsSync(collabAgentAccountPath('ghost'))).toBe(true)
  })

  it('marker 落在 collab/v3-migrated.json,带版本与统计', async () => {
    seedTypicalStore()
    const report = await migrateCollabToV3({ dryRun: false, now: () => NOW })
    const marker = readCollabV3MigrationMarker()
    expect(marker?.version).toBe(1)
    expect(marker?.at).toBe(NOW)
    expect(marker?.backupDir).toBe(report.backupDir)
    expect(marker?.totals).toEqual(report.totals)
  })
})

/* ── 幂等 ──────────────────────────────────────────────────────────────── */

describe('幂等重入', () => {
  it('marker 存在 → 整体跳过,一个字节不动', async () => {
    seedTypicalStore()
    await migrateCollabToV3({ dryRun: false, now: () => NOW })
    const after = snapshot(storeRoot)

    const again = await migrateCollabToV3({ dryRun: false, now: () => NOW + 1 })
    expect(again.skipped).toBe(true)
    expect(again.rooms).toEqual([])
    expect(snapshot(storeRoot)).toEqual(after)
  })

  it('marker 被删了也不重复投:v3 账已存在的房跳过,回填按事件 id 去重', async () => {
    seedTypicalStore()
    await migrateCollabToV3({ dryRun: false, now: () => NOW })
    const inbox = path.join(collabAgentActorDir(IRIS), 'inbox.jsonl')
    const firstLog = await readActorMailboxLog(inbox)

    fs.rmSync(collabV3MigrationMarkerPath())
    const again = await migrateCollabToV3({ dryRun: false, now: () => NOW + 1 })

    expect(again.rooms[0].status).toBe('skipped')
    expect(again.totals.roomsSkipped).toBe(1)
    const secondLog = await readActorMailboxLog(inbox)
    expect(secondLog.map(event => event.id)).toEqual(firstLog.map(event => event.id))
  })

  it('房间账已存在时不覆盖 —— 一份在跑的 v3 账不能被 v2 的旧数据顶掉', async () => {
    seedTypicalStore()
    const live = { ...createCollabRoomAccount(ROOM, { epoch: 99 }), chainCount: 42, seq: 7 }
    createCollabRoomAccountFileStore().save(live)

    await migrateCollabToV3({ dryRun: false, now: () => NOW })
    const account = createCollabRoomAccountFileStore().load(ROOM)
    expect(account.chainCount).toBe(42)
    expect(account.floor.epoch).toBe(99)
  })

  it('agent 账里已经有这间房的那一格时,连带回填也不投', async () => {
    seedTypicalStore()
    await migrateCollabToV3({ dryRun: false, now: () => NOW })
    // 把房间账删掉、marker 删掉,只留 agent 账 —— 逼迁移器重走一遍 agent 那一侧。
    fs.rmSync(collabV3MigrationMarkerPath())
    fs.rmSync(collabRoomAccountPath(ROOM))
    const before = await readActorMailboxLog(path.join(collabAgentActorDir(IRIS), 'inbox.jsonl'))

    await migrateCollabToV3({ dryRun: false, now: () => NOW + 1 })
    const after = await readActorMailboxLog(path.join(collabAgentActorDir(IRIS), 'inbox.jsonl'))
    expect(after.map(event => event.id)).toEqual(before.map(event => event.id))
  })
})

/* ── 备份与安全 ────────────────────────────────────────────────────────── */

describe('备份与安全', () => {
  it('collab/** 整体拷进 backup/collab-v2-<时间戳>/,逐文件一致', async () => {
    seedTypicalStore()
    const source = snapshot(path.join(storeRoot, 'collab'))

    const report = await migrateCollabToV3({ dryRun: false, now: () => NOW })
    expect(report.backupDir).toBe(collabV2BackupDir('2026-08-03T12-34-56'))

    const backup = snapshot(report.backupDir!)
    for (const [relative, content] of source) {
      expect(backup.get(relative)).toBe(content)
    }
    // 备份的是**迁移前**的样子:v3 的账不在里面。
    expect(backup.has(path.join(ROOM, 'actors', 'room.json'))).toBe(false)
  })

  it('不备份 sessions/ —— 全量快照会拖进几百 MB 会话', async () => {
    seedTypicalStore()
    const report = await migrateCollabToV3({ dryRun: false, now: () => NOW })
    const backup = snapshot(report.backupDir!)
    expect([...backup.keys()].some(key => key.includes('sessions'))).toBe(false)
  })

  it('全新的店也留下一个空备份目录 —— 「跑过了」与「忘了跑」不能长得一样', async () => {
    const report = await migrateCollabToV3({ dryRun: false, now: () => NOW })
    expect(fs.existsSync(report.backupDir!)).toBe(true)
    expect(report.rooms).toEqual([])
  })

  it('全程不写 sessions/ 下任何文件', async () => {
    seedTypicalStore()
    const before = snapshot(path.join(storeRoot, 'sessions'))
    await migrateCollabToV3({ dryRun: false, now: () => NOW })
    expect(snapshot(path.join(storeRoot, 'sessions'))).toEqual(before)
  })

  it('v2 账一个都不删', async () => {
    seedTypicalStore()
    const before = snapshot(path.join(storeRoot, 'collab', ROOM))
    await migrateCollabToV3({ dryRun: false, now: () => NOW })
    for (const [relative, content] of before) {
      expect(fs.readFileSync(path.join(storeRoot, 'collab', ROOM, relative), 'utf-8')).toBe(content)
    }
  })
})

/* ── 坏数据 ────────────────────────────────────────────────────────────── */

describe('坏数据不中断全局', () => {
  it('半截 JSON 的 state.json → 该房 failed,其它房照迁', async () => {
    seedTypicalStore()
    fs.mkdirSync(path.join(storeRoot, 'collab', 'room-broken'), { recursive: true })
    fs.writeFileSync(path.join(storeRoot, 'collab', 'room-broken', 'state.json'), '{"version":1,"chai', 'utf-8')

    const report = await migrateCollabToV3({ dryRun: false, now: () => NOW })
    const broken = report.rooms.find(room => room.roomId === 'room-broken')
    expect(broken?.status).toBe('failed')
    expect(broken?.error).toContain('state.json 读不动')
    expect(report.rooms.find(room => room.roomId === ROOM)?.status).toBe('migrated')
    expect(report.totals.roomsFailed).toBe(1)
    expect(report.totals.roomsMigrated).toBe(1)
    // 坏房不该留下半份 v3 账。
    expect(fs.existsSync(collabRoomAccountPath('room-broken'))).toBe(false)
  })

  it('认不出形状的 state.json(缺 version)也是 failed,不是「当新房迁」', async () => {
    seedV2Room('room-weird', { chainCount: 9 })
    const report = await migrateCollabToV3({ dryRun: true, now: () => NOW })
    expect(report.rooms[0].status).toBe('failed')
    expect(report.rooms[0].error).toContain('认不出形状')
  })

  it('零迁移三类的校验结论进报告(转录缺失 / 看板坏了)', async () => {
    seedV2Room('room-no-session', { version: 1, chainCount: 0, floorEpoch: 1 }, null)
    fs.writeFileSync(path.join(storeRoot, 'collab', 'room-no-session', 'board.json'), '{oops', 'utf-8')

    const report = await migrateCollabToV3({ dryRun: true, now: () => NOW })
    const checks = report.rooms[0].checks
    expect(checks.find(check => check.kind === 'transcript')?.status).toBe('absent')
    expect(checks.find(check => check.kind === 'board')?.status).toBe('unreadable')
    expect(report.totals.checksUnreadable).toBe(1)
  })

  it('旧的整份 JSON 会话也读得动(转录零迁移,两种形态都认)', async () => {
    fs.mkdirSync(path.join(storeRoot, 'sessions'), { recursive: true })
    writeJson(path.join(storeRoot, 'sessions', `${ROOM}.json`), {
      id: ROOM,
      kind: 'room',
      room: { memberAgentIds: [IRIS] },
      messages: [
        { id: 'm1', role: 'user', content: 'a', timestamp: 1 },
        { id: 'm2', role: 'user', content: 'b', timestamp: 2 },
      ],
    })
    writeJson(path.join(storeRoot, 'sessions', `agent-exec-${IRIS}-${ROOM}.json`), {
      id: `agent-exec-${IRIS}-${ROOM}`,
      kind: 'agent',
      collab: { roomSessionId: ROOM, seenMessageId: 'm1' },
      messages: [],
    })
    seedV2Room(ROOM, { version: 1, chainCount: 0, floorEpoch: 1 })

    const report = await migrateCollabToV3({ dryRun: true, now: () => NOW })
    expect(report.rooms[0].checks.find(check => check.kind === 'transcript')?.count).toBe(2)
    expect(report.rooms[0].agents[0]).toMatchObject({ agentId: IRIS, seenIndex: 0, backfilled: 1 })
  })
})
