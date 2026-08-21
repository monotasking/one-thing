/**
 * 一个 agent 的 v3 家当落在盘上的形状:信箱、账、笔记。
 *
 * 两条纪律在这里被钉住:
 *  - **路径全部经 `getOnethingStorePath()` 家族解析**,一个硬编码的字面量都没有;
 *  - **账跨重启活得下来**,而且是同步原子写(崩溃点不会开出「决定了但没记下」的窗口)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createActorEvent, type ActorEvent } from '@onething/core/actors'
import {
  advanceCollabAgentDelivered,
  collabAgentRoomAccount,
  createCollabAgentAccount,
  recordCollabAgentLease,
  type CollabActorVerb,
} from '../index.js'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-agent-mailbox-'))
vi.mock('../../../storage/index.js', () => ({ getOnethingStorePath: () => storeRootRef.value }))
const storeRootRef = { value: storeRoot }

const {
  COLLAB_AGENTS_V3_DIR,
  collabAgentAccountPath,
  collabAgentActorDir,
  collabAgentNotebookPath,
  createCollabAgentAccountFileStore,
  openCollabAgentMailbox,
} = await import('../agent-mailbox.js')
const { createCollabNotebookFileStore } = await import('../notebook-store.js')

afterAll(() => {
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const AGENT = 'iris'
const ROOM = 'room-1'

beforeEach(() => {
  fs.rmSync(path.join(storeRoot, COLLAB_AGENTS_V3_DIR), { recursive: true, force: true })
})

function note(index: number): ActorEvent<CollabActorVerb> {
  return createActorEvent<CollabActorVerb>({
    id: `evt-${index}`,
    at: 1_000 + index,
    type: 'agent:note',
    from: { kind: 'agent', id: AGENT },
    to: { kind: 'agent', id: AGENT },
    payload: { type: 'agent:note', agentId: AGENT, note: `第 ${index} 条` },
  })
}

describe('路径', () => {
  it('三样家当都在 `<store>/agents-v3/<agentId>/` 下', () => {
    expect(collabAgentActorDir(AGENT)).toBe(path.join(storeRoot, 'agents-v3', AGENT))
    expect(collabAgentAccountPath(AGENT)).toBe(path.join(collabAgentActorDir(AGENT), 'state.json'))
    expect(collabAgentNotebookPath(AGENT)).toBe(path.join(collabAgentActorDir(AGENT), 'notebook.md'))
  })

  it('换一个 store 根,路径跟着走(没有硬编码的字面量)', () => {
    storeRootRef.value = path.join(storeRoot, 'elsewhere')
    expect(collabAgentActorDir(AGENT).startsWith(storeRootRef.value)).toBe(true)
    storeRootRef.value = storeRoot
  })
})

describe('持久信箱', () => {
  it('inbox.jsonl + inbox.cursor 两个文件,内容跨重开还在', async () => {
    const mailbox = await openCollabAgentMailbox(AGENT)
    await mailbox.append(note(1))
    await mailbox.append(note(2))
    await mailbox.flush()
    expect(fs.existsSync(path.join(collabAgentActorDir(AGENT), 'inbox.jsonl'))).toBe(true)

    const batches = mailbox.batches()
    const first = await batches.next()
    expect(first.value?.events).toHaveLength(2)
    mailbox.ack(first.value!.cursor)
    mailbox.close()
    expect(fs.existsSync(path.join(collabAgentActorDir(AGENT), 'inbox.cursor'))).toBe(true)

    // 重开:游标在盘上,已经 ack 过的那两封不再投递。
    const reopened = await openCollabAgentMailbox(AGENT)
    expect(reopened.cursor).toBe(2)
    expect(reopened.pendingCount()).toBe(0)
    reopened.close()
  })

  it('未 ack 的那一批重开后原样重投(at-least-once)', async () => {
    const mailbox = await openCollabAgentMailbox(AGENT)
    await mailbox.append(note(1))
    await mailbox.flush()
    mailbox.close()

    const reopened = await openCollabAgentMailbox(AGENT)
    expect(reopened.pendingCount()).toBe(1)
    reopened.close()
  })

  it('别人的信箱开不了 —— 主人写在 header 上', async () => {
    const mailbox = await openCollabAgentMailbox(AGENT)
    await mailbox.flush()
    mailbox.close()
    fs.mkdirSync(collabAgentActorDir('bram'), { recursive: true })
    fs.copyFileSync(
      path.join(collabAgentActorDir(AGENT), 'inbox.jsonl'),
      path.join(collabAgentActorDir('bram'), 'inbox.jsonl'),
    )
    await expect(openCollabAgentMailbox('bram')).rejects.toThrow(/belongs to/)
  })
})

describe('账', () => {
  it('落盘之后原样认回来', () => {
    const store = createCollabAgentAccountFileStore()
    let account = createCollabAgentAccount(AGENT)
    account = advanceCollabAgentDelivered(account, ROOM, 'm1', 1_000)
    account = recordCollabAgentLease(account, { roomId: ROOM, leaseId: 'L1', epoch: 1, issuedAt: 1_000 })
    store.save(account)

    const loaded = store.load(AGENT)
    expect(loaded).toEqual(account)
    expect(collabAgentRoomAccount(loaded, ROOM).deliveredMessageId).toBe('m1')
  })

  it('从没写过账 = 新账,而不是抛', () => {
    expect(createCollabAgentAccountFileStore().load('never-seen'))
      .toEqual(createCollabAgentAccount('never-seen'))
  })

  it('半份账(手改坏了)退回新账,而不是带着一个 undefined 往下走', () => {
    const store = createCollabAgentAccountFileStore()
    fs.mkdirSync(collabAgentActorDir(AGENT), { recursive: true })
    fs.writeFileSync(collabAgentAccountPath(AGENT), '{"agentId":"someone-else"}', 'utf-8')
    expect(store.load(AGENT)).toEqual(createCollabAgentAccount(AGENT))
  })
})

describe('笔记', () => {
  it('追加到 notebook.md,读回来是全文', () => {
    const store = createCollabNotebookFileStore()
    expect(store.read(AGENT)).toBe('')
    const first = store.append({ agentId: AGENT, note: '第一条', at: Date.parse('2026-08-03T10:00:00') })
    store.append({ agentId: AGENT, note: '第二条', at: Date.parse('2026-08-03T11:00:00'), roomLabel: '产品房' })

    const book = store.read(AGENT)
    expect(book).toContain(first.entry)
    expect(book).toContain('(产品房) 第二条')
    expect(book.trim().split('\n')).toHaveLength(2)
  })

  it('数的是字符不是字节 —— 一本中文笔记按字节算是三倍', () => {
    const store = createCollabNotebookFileStore()
    const written = store.append({ agentId: AGENT, note: '中文中文中文', at: Date.now() })
    expect(written.totalChars).toBe(store.read(AGENT).length)
    expect(written.totalChars).toBeLessThan(fs.statSync(collabAgentNotebookPath(AGENT)).size)
  })
})
