/**
 * `scripts/collab-v3-inspect.mjs` 的**端到端**冒烟(D8 §5,O3)。
 *
 * 纯段的行为由 `inspect-rules.test.ts` 钉死;这一份问的是另一件事:**那个 `.mjs`
 * 真的跑得起来吗**。它读的是磁盘布局(`collab/<id>/actors/room.json`、
 * `agents-v3/<id>/{state.json,inbox.jsonl,inbox.cursor}`、`scheduler-log-<日>.jsonl`、
 * `sessions/<id>/meta.json`、`agents.json`)——那套布局没有任何一处类型能保证,
 * 一次目录改名就会让 CLI 在真机上安静地报「这个 store 里没有 v3 房账」。
 *
 * 所以这里造一份**真的临时 store**,起真的子进程,断言 `--json` 的输出。
 * 与 `file-mutex-cross-process.test.ts` 同款做法(bun 缺席就跳过)。
 *
 * ⚠️ 全程只碰 `mkdtemp` 出来的目录,一个字节都不写 `~/.onething`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCollabAgentAccount } from '../mind-rules.js'
import { createCollabRoomAccount } from '../room-rules.js'
import {
  collabSchedulerDeadLetter,
  collabSchedulerGateBlock,
  collabSchedulerGrant,
  collabSchedulerHand,
  collabSchedulerJudgeOpen,
  collabSchedulerJudgeVerdict,
  collabSchedulerPosted,
  collabSchedulerSpeak,
  collabSchedulerLogFileName,
  formatCollabSchedulerLogLine,
  type CollabSchedulerLogRow,
} from '../scheduler-log-rules.js'

const scriptPath = fileURLToPath(new URL('../../../../../../scripts/collab-v3-inspect.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

function hasBun(): boolean {
  try {
    return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

const ROOM_ID = 'room-fixture-1'
const IRIS = 'agent-iris'
const BRAM = 'agent-bram'
const NOW = Date.now()

let store = ''

function write(relative: string, content: string): void {
  const file = path.join(store, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf-8')
}

function seedStore(): void {
  write('agents.json', JSON.stringify({
    version: 1,
    agents: [
      { id: IRIS, name: 'Iris' },
      { id: BRAM, name: 'Bram' },
    ],
  }))

  write(`sessions/${ROOM_ID}/meta.json`, JSON.stringify({
    id: ROOM_ID,
    name: '产品组',
    kind: 'room',
    room: { memberAgentIds: [IRIS, BRAM], budgets: { maxConcurrentTurns: 1, maxChain: 8 } },
  }))

  const room = createCollabRoomAccount(ROOM_ID)
  write(`collab/${ROOM_ID}/actors/room.json`, JSON.stringify({
    ...room,
    chainCount: 4,
    watermark: { messageId: 'msg-9', at: NOW - 60_000 },
    floor: {
      ...room.floor,
      active: [{ leaseId: 'lease-1', epoch: room.floor.epoch, roomId: ROOM_ID, agentId: IRIS, issuedAt: NOW - 30_000 }],
    },
    leaseReasons: { 'lease-1': 'mention' },
    hands: [{ agentId: BRAM, at: NOW - 20_000, origin: 'hand', reason: 'self-elected' }],
    seq: 12,
  }))

  // 时间轴:一条消息进房之后完整的一串(因果链能从 posted 一路走到 speak)。
  const rows: CollabSchedulerLogRow[] = [
    collabSchedulerPosted({ at: NOW - 50_000, messageId: 'msg-9', authorKind: 'user' }),
    collabSchedulerHand({ at: NOW - 49_000, agentId: IRIS, reason: 'mention', origin: 'mention', triggeredBy: 'msg-9' }),
    collabSchedulerHand({ at: NOW - 48_500, agentId: BRAM, reason: 'self-elected', origin: 'hand', triggeredBy: 'msg-9' }),
    collabSchedulerJudgeOpen({ at: NOW - 48_000, token: 'j-1', candidates: [IRIS, BRAM], triggeredBy: 'msg-9' }),
    collabSchedulerJudgeVerdict({
      at: NOW - 46_000,
      token: 'j-1',
      order: [IRIS],
      why: '他被点名了',
      elapsedMs: 1_900,
      model: 'test-model',
      triggeredBy: 'msg-9',
    }),
    collabSchedulerGrant({ at: NOW - 30_000, agentId: IRIS, leaseId: 'lease-1', reason: 'mention', triggeredBy: 'msg-9' }),
    collabSchedulerGateBlock({ at: NOW - 20_000, agentId: BRAM, gate: 'seats', triggeredBy: 'msg-9' }),
    collabSchedulerSpeak({ at: NOW - 10_000, agentId: IRIS, leaseId: 'lease-1', messageId: 'msg-10', triggeredBy: 'lease-1' }),
    collabSchedulerDeadLetter({
      at: NOW - 5_000,
      actor: `agent:${BRAM}`,
      eventType: 'room:posted',
      error: '信封折不动',
      triggeredBy: 'evt-77',
    }),
  ]
  write(
    `collab/${ROOM_ID}/actors/${collabSchedulerLogFileName(NOW)}`,
    `${rows.map(row => formatCollabSchedulerLogLine(row)).join('\n')}\n`,
  )

  const iris = createCollabAgentAccount(IRIS)
  write(`agents-v3/${IRIS}/state.json`, JSON.stringify({
    ...iris,
    rooms: { [ROOM_ID]: { turns: 7, lastTurnAt: NOW - 10_000, readMessageId: 'msg-9' } },
    workers: [{ cardId: 'card-1', roomId: ROOM_ID, workerId: 'w-1', status: 'running', startedAt: NOW - 120_000 }],
    seq: 31,
  }))
  // 信箱:三封信,游标停在 1 → 积压 2,最旧那封是 seq=2 的到达时刻。
  write(`agents-v3/${IRIS}/inbox.jsonl`, [
    JSON.stringify({ t: 'h', v: 1, sessionId: IRIS }),
    JSON.stringify({ t: 'm', seq: 1, m: { id: 'e1', at: NOW - 90_000, type: 'room:posted' } }),
    JSON.stringify({ t: 'm', seq: 2, m: { id: 'e2', at: NOW - 40_000, type: 'room:posted' } }),
    JSON.stringify({ t: 'm', seq: 3, m: { id: 'e3', at: NOW - 3_000, type: 'room:floor-granted' } }),
    '',
  ].join('\n'))
  write(`agents-v3/${IRIS}/inbox.cursor`, JSON.stringify({ v: 1, ownerId: IRIS, seq: 1, at: NOW, seen: [] }))

  write(`agents-v3/${BRAM}/state.json`, JSON.stringify(createCollabAgentAccount(BRAM)))
}

function runInspect(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [scriptPath, '--store', store, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    // 环境里的 ONETHING_STORE_PATH 不该影响这次调用 —— `--store` 是显式的那一个。
    env: { ...process.env, ONETHING_STORE_PATH: '' },
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runJson(args: string[]): Record<string, unknown> {
  const result = runInspect([...args, '--json'])
  expect(result.status, `stderr: ${result.stderr}`).toBe(0)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

describe.skipIf(!hasBun())('collab-v3-inspect CLI(端到端,临时 store)', () => {
  beforeAll(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-v3-inspect-'))
    seedStore()
  })

  afterAll(() => {
    if (store) fs.rmSync(store, { recursive: true, force: true })
  })

  it('总览:房 × 同事各一行,持牌/举手/信箱/死信都从盘上数出来', () => {
    const report = runJson([]) as {
      mode: string
      totals: Record<string, number>
      rooms: Array<Record<string, unknown>>
      agents: Array<Record<string, unknown>>
    }
    expect(report.mode).toBe('overview')
    expect(report.totals).toMatchObject({
      rooms: 1, agents: 2, leases: 1, hands: 1, deadLetters: 1, inboxBacklog: 2,
    })
    expect(report.rooms[0]).toMatchObject({ roomId: ROOM_ID, name: '产品组', policy: 'free' })
    expect(report.rooms[0]!.seats).toEqual({ used: 1, max: 1 })
    expect(report.rooms[0]!.chain).toMatchObject({ value: 4, max: 8 })
    // 持牌的排前面。
    expect(report.agents[0]).toMatchObject({ agentId: IRIS, name: 'Iris' })
  }, 60_000)

  it('单房:租约 + 举手判据 + 裁决回放 + 时间轴尾 20', () => {
    // 按**名字**找房 —— uuid 没人愿意手抄。
    const report = runJson(['--room', '产品组']) as {
      mode: string
      room: Record<string, any>
      tail: CollabSchedulerLogRow[]
    }
    expect(report.mode).toBe('room')
    expect(report.room.leases).toEqual([
      { agentId: IRIS, leaseId: 'lease-1', since: NOW - 30_000, heldMs: expect.any(Number), epoch: 1, reason: 'mention' },
    ])
    expect(report.room.hands[0]).toMatchObject({ agentId: BRAM, blockedBy: 'seats', loggedGate: 'seats' })
    expect(report.room.judgment.lastVerdict).toMatchObject({
      token: 'j-1', order: [IRIS], why: '他被点名了', elapsedMs: 1_900, model: 'test-model',
    })
    expect(report.room.deadLetters).toBe(1)
    expect(report.room.mailbox).toBeUndefined()
    // 尾读新在前。
    expect(report.tail[0]?.type).toBe('dead-letter')
    expect(report.tail).toHaveLength(9)
  }, 60_000)

  it('单人:持牌来自房账、邮箱来自游标差、工作卡与涉入房俱全', () => {
    const report = runJson(['--agent', 'Iris']) as { mode: string; agent: Record<string, any> }
    expect(report.mode).toBe('agent')
    expect(report.agent).toMatchObject({ agentId: IRIS, name: 'Iris', deadLetters: 0 })
    expect(report.agent.leases[0]).toMatchObject({ roomSessionId: ROOM_ID, roomName: '产品组', leaseId: 'lease-1' })
    expect(report.agent.inbox).toMatchObject({ depth: 2, oldestAt: NOW - 40_000 })
    expect(report.agent.workers[0]).toMatchObject({ cardId: 'card-1', status: 'running' })
    expect(report.agent.rooms[0]).toMatchObject({ roomSessionId: ROOM_ID, turns: 7 })

    // 死信按 actor 归位:那一条是 Bram 的,不该记到 Iris 头上。
    const bram = runJson(['--agent', 'Bram']) as { agent: Record<string, any> }
    expect(bram.agent.deadLetters).toBe(1)
  }, 60_000)

  it('时间轴:--tail 截断新在前,--type 过滤只留想看的那几类', () => {
    const tail = runJson(['--tail', '3']) as { rows: Array<Record<string, unknown>> }
    expect(tail.rows).toHaveLength(3)
    expect(tail.rows[0]).toMatchObject({ roomId: ROOM_ID, type: 'dead-letter' })
    expect((tail.rows[0]!.at as number) >= (tail.rows[1]!.at as number)).toBe(true)

    const filtered = runJson(['--tail', '20', '--type', 'judge-verdict,grant']) as {
      rows: Array<Record<string, unknown>>
    }
    expect(filtered.rows.map(row => row.type)).toEqual(['grant', 'judge-verdict'])
  }, 60_000)

  it('死信:按 actor 分组,带事件类型与错误首行', () => {
    const report = runJson(['--dead-letters']) as { groups: Array<Record<string, unknown>> }
    expect(report.groups).toHaveLength(1)
    expect(report.groups[0]).toMatchObject({
      actor: `agent:${BRAM}`,
      count: 1,
      eventTypes: ['room:posted'],
      rooms: [ROOM_ID],
      latestError: '信封折不动',
    })
  }, 60_000)

  it('人读版:总览印「持牌」而不是「发言中」,并挂着两条进程外声明', () => {
    const result = runInspect([])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('持牌')
    expect(result.stdout).not.toContain('发言中')
    expect(result.stdout).toContain('执行态需进程内')
    expect(result.stdout).toContain('判据不含预算闸')
  }, 60_000)

  it('用法错:不认识的参数退 2,找不到目标退 1 —— 这条命令会被接在 && 后面', () => {
    expect(runInspect(['--nope']).status).toBe(2)
    expect(runInspect(['--tail', 'abc']).status).toBe(2)
    const missing = runInspect(['--room', '这间房不存在'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('找不到房')
  }, 60_000)
})
