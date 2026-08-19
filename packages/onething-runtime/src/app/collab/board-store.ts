/**
 * Board store — the room's task source of truth on disk (D6).
 *
 * <store>/collab/<roomId>/board.json   whole-file JSON, small
 * <store>/collab/<roomId>/activity.jsonl  append-only audit trail
 *
 * ALL mutations (tool calls and UI alike) go through applyBoardAction: a
 * per-room in-memory queue serializes writers, the pure reducer enforces
 * revs, every change broadcasts a 'collab:board-changed' session event on the
 * room session (the desktop IPCBridge already fans those out to the
 * renderer), and semantic events feed the coordinator's worker lifecycle.
 */
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readJsonFile, writeJsonFile } from '@onething/core/storage'
import {
  applyCollabBoardAction,
  emptyCollabBoard,
  type CollabBoard,
  type CollabBoardAction,
  type CollabBoardActor,
  type CollabBoardEvent,
  type CollabSelfTaskFact,
  type CollabTask,
} from '@onething/runtime/collab'
import { getEventBus } from '../events/index.js'
import { getStorePath } from '../stores/paths.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.board')


export interface CollabBoardActionOutcome {
  task?: CollabTask
  board: CollabBoard
  error?: string
}

type BoardEventListener = (roomSessionId: string, event: CollabBoardEvent) => void

const listeners = new Set<BoardEventListener>()
const writeQueues = new Map<string, Promise<unknown>>()

function boardDir(roomSessionId: string): string {
  return path.join(getStorePath(), 'collab', roomSessionId)
}

function boardPath(roomSessionId: string): string {
  return path.join(boardDir(roomSessionId), 'board.json')
}

export function loadCollabBoard(roomSessionId: string): CollabBoard {
  const raw = readJsonFile<CollabBoard | null>(boardPath(roomSessionId), null)
  if (raw && raw.version === 1 && Array.isArray(raw.tasks)) return raw
  return emptyCollabBoard()
}

export function getCollabTask(roomSessionId: string, taskId: string): CollabTask | undefined {
  return loadCollabBoard(roomSessionId).tasks.find(task => task.id === taskId)
}

/**
 * The agent's own IN-FLIGHT cards (W9.3) — the fact an agent had no way of
 * knowing: work runs in a separate session, so the room-side persona could
 * only guess at what it was "doing" (真机事故:被 @ 后凭空断言「已交付」).
 * doing + blocked only: settled cards (done/review/backlog) are history, and
 * a plate with nothing on it is not worth a prompt line.
 */
export function getCollabSelfTaskFacts(roomSessionId: string, agentId: string): CollabSelfTaskFact[] {
  const facts: CollabSelfTaskFact[] = []
  for (const task of loadCollabBoard(roomSessionId).tasks) {
    if (task.assigneeAgentId !== agentId) continue
    if (task.status !== 'doing' && task.status !== 'blocked') continue
    facts.push({ id: task.id, title: task.title, status: task.status })
  }
  return facts
}

/**
 * Stamp the commit counter (P2-18). Every snapshot that leaves this module —
 * to disk, to the broadcast, to a write's reply — carries a number strictly
 * greater than the one it replaces, which is what lets the renderer discard a
 * stale arrival instead of repainting backwards.
 */
function stamped(previous: CollabBoard, next: CollabBoard): CollabBoard {
  return { ...next, seq: (previous.seq ?? 0) + 1 }
}

function appendActivity(roomSessionId: string, entry: { at: number; actor: string; note: string }): void {
  try {
    fs.mkdirSync(boardDir(roomSessionId), { recursive: true })
    fs.appendFileSync(
      path.join(boardDir(roomSessionId), 'activity.jsonl'),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    )
  } catch (error) {
    log.error('board activity append failed', { roomSessionId }, error)
  }
}

/**
 * Board broadcast coalescing (W13.4, 父文档 §10.9 转正).
 *
 * A single tool call can walk a card through several writes (assign → status →
 * report), and each one used to fan a whole board snapshot out to the renderer.
 * The board is a REPLACE-the-snapshot event, so a trailing-edge merge is
 * lossless: within the window the last snapshot simply wins (BrowserService's
 * BROWSER_TABS_CHANGED coalescer, same 30ms, same shape).
 *
 * Only the BROADCAST is throttled. board.json is written and activity.jsonl is
 * appended synchronously on every action — the audit trail must not lose a step
 * just because the UI does not need one repaint per write.
 */
const BOARD_BROADCAST_COALESCE_MS = 30

interface PendingBoardBroadcast {
  timer: ReturnType<typeof setTimeout>
  board: CollabBoard
}

const pendingBroadcasts = new Map<string, PendingBoardBroadcast>()

function emitBoardChanged(roomSessionId: string, board: CollabBoard): void {
  void getEventBus().emit(roomSessionId, {
    type: SESSION_EVENT_TYPES.COLLAB_BOARD_CHANGED,
    board,
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
}

function broadcastBoardChanged(roomSessionId: string, board: CollabBoard): void {
  const pending = pendingBroadcasts.get(roomSessionId)
  if (pending) {
    // Later snapshot wins; the already-armed timer keeps the window bounded so
    // a long burst cannot postpone the flush indefinitely.
    pending.board = board
    return
  }
  const timer = setTimeout(() => {
    const entry = pendingBroadcasts.get(roomSessionId)
    pendingBroadcasts.delete(roomSessionId)
    if (entry) emitBoardChanged(roomSessionId, entry.board)
  }, BOARD_BROADCAST_COALESCE_MS)
  // A pending repaint must never hold the process open (CLI/daemon exit).
  timer.unref?.()
  pendingBroadcasts.set(roomSessionId, { timer, board })
}

/** Drop a room's pending repaint without emitting it (room deleted / shutdown). */
export function clearCollabBoardBroadcast(roomSessionId: string): void {
  const pending = pendingBroadcasts.get(roomSessionId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingBroadcasts.delete(roomSessionId)
}

/**
 * The room is gone (P2-10): drop its pending repaint AND its write-queue entry.
 *
 * `writeQueues` is keyed by room and was only ever added to — every room the
 * process ever wrote a board for kept a resolved promise alive for the lifetime
 * of the process.
 */
export function forgetCollabBoardRoom(roomSessionId: string): void {
  clearCollabBoardBroadcast(roomSessionId)
  writeQueues.delete(roomSessionId)
}

/** Process teardown: every armed timer is dropped, nothing is emitted. */
export function shutdownCollabBoardBroadcasts(): void {
  for (const roomSessionId of [...pendingBroadcasts.keys()]) {
    clearCollabBoardBroadcast(roomSessionId)
  }
}

/** Coordinator subscription to semantic board events (assign/complete/...). */
export function onCollabBoardEvent(listener: BoardEventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function applyBoardAction(
  roomSessionId: string,
  action: CollabBoardAction,
  actor: CollabBoardActor,
): Promise<CollabBoardActionOutcome> {
  const previous = writeQueues.get(roomSessionId) ?? Promise.resolve()
  const run = previous.then(() => {
    const board = loadCollabBoard(roomSessionId)
    const result = applyCollabBoardAction(board, action, actor, {
      now: Date.now(),
      createId: randomUUID,
    })
    if (result.error) return { board, error: result.error }

    let committed = result.board
    if (result.board !== board) {
      committed = stamped(board, result.board)
      writeJsonFile(boardPath(roomSessionId), committed)
      if (result.activity) appendActivity(roomSessionId, result.activity)
      broadcastBoardChanged(roomSessionId, committed)
    }
    if (result.event) {
      for (const listener of listeners) {
        try {
          listener(roomSessionId, result.event)
        } catch (error) {
          log.error('board event listener failed', { roomSessionId }, error)
        }
      }
    }
    return { board: committed, task: result.task }
  })
  writeQueues.set(roomSessionId, run.catch(() => {}))
  return run
}

/**
 * 清空这间房的看板(随「清空聊天记录」一同发生)。
 *
 * 走**同一条写队列**:一次在飞的 applyBoardAction 若排在后面,它读到的是清空后
 * 的空看板,而不是把刚被清掉的旧快照重新落盘。activity.jsonl 一并删 —— 它是这
 * 些卡片的审计轨,卡片没了它就是一串指向不存在卡片的孤儿记录。
 *
 * seq 照常 +1(不是归零):渲染层用它丢弃过期到达,一份 seq 更小的空看板会被当
 * 成旧快照原地忽略,清空在界面上就不存在。
 */
export async function clearCollabBoard(roomSessionId: string): Promise<{ clearedTaskCount: number }> {
  const previous = writeQueues.get(roomSessionId) ?? Promise.resolve()
  const run = previous.then(() => {
    // 从没有过看板的房(私聊房多半如此)不该因为一次清空凭空多出一个 board.json。
    if (!fs.existsSync(boardPath(roomSessionId))) return { clearedTaskCount: 0 }
    const board = loadCollabBoard(roomSessionId)
    const clearedTaskCount = board.tasks.length
    const next = stamped(board, emptyCollabBoard())
    writeJsonFile(boardPath(roomSessionId), next)
    try {
      fs.rmSync(path.join(boardDir(roomSessionId), 'activity.jsonl'), { force: true })
    } catch (error) {
      log.error('board activity trail cleanup failed', { roomSessionId }, error)
    }
    broadcastBoardChanged(roomSessionId, next)
    return { clearedTaskCount }
  })
  writeQueues.set(roomSessionId, run.catch(() => {}))
  return run
}

/**
 * Coordinator-internal mutation that must NOT re-trigger semantic events
 * (e.g. attaching a workSessionId after spawning, recording report message
 * ids, or force-moving a task without the 打回 accounting).
 */
export async function patchCollabTask(
  roomSessionId: string,
  taskId: string,
  patch: Partial<Pick<CollabTask, 'status' | 'workSessionIds' | 'report' | 'rejections' | 'haltedCount' | 'blockReason'>>,
): Promise<CollabTask | undefined> {
  const previous = writeQueues.get(roomSessionId) ?? Promise.resolve()
  const run = previous.then(() => {
    const board = loadCollabBoard(roomSessionId)
    const index = board.tasks.findIndex(task => task.id === taskId)
    if (index < 0) return undefined
    const task: CollabTask = {
      ...board.tasks[index],
      ...patch,
      rev: board.tasks[index].rev + 1,
      updatedAt: Date.now(),
    }
    const tasks = [...board.tasks]
    tasks[index] = task
    const next = stamped(board, { ...board, tasks })
    writeJsonFile(boardPath(roomSessionId), next)
    broadcastBoardChanged(roomSessionId, next)
    return task
  })
  writeQueues.set(roomSessionId, run.catch(() => {}))
  return run
}
