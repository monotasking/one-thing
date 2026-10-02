import * as path from 'path'

/**
 * Per-path read/write lock.
 *
 * Writers (edit/write/audit rollback) are exclusive and FIFO among themselves.
 * Readers run concurrently with each other but always wait for every writer
 * already queued at the time they arrive, and any writer arriving later waits
 * for readers already in flight. This keeps a read dispatched after an edit of
 * the same file from observing pre-edit bytes.
 *
 * The done-promises below are always resolved (never rejected) in a finally
 * block, so waiters can await them directly without rejection handling.
 */
interface PathQueue {
  /** Latest queued/running writer, or null when no writer is in flight. */
  writerTail: Promise<void> | null
  /** In-flight readers; a newly queued writer waits for a snapshot of these. */
  readers: Set<Promise<void>>
  pendingWriters: number
}

const queues = new Map<string, PathQueue>()

function normalizeQueueKey(filePath: string): string {
  return path.resolve(filePath)
}

function getQueue(key: string): PathQueue {
  let queue = queues.get(key)
  if (!queue) {
    queue = { writerTail: null, readers: new Set(), pendingWriters: 0 }
    queues.set(key, queue)
  }
  return queue
}

function maybeReleaseQueue(key: string, queue: PathQueue): void {
  if (queue.pendingWriters === 0 && queue.readers.size === 0 && queues.get(key) === queue) {
    queues.delete(key)
  }
}

export async function withFileMutationQueue<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = normalizeQueueKey(filePath)
  const queue = getQueue(key)
  queue.pendingWriters += 1

  const previousWriter = queue.writerTail
  const priorReaders = queue.readers.size > 0 ? Array.from(queue.readers) : null

  let releaseCurrent!: () => void
  const currentDone = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  queue.writerTail = currentDone

  if (previousWriter) await previousWriter
  if (priorReaders) await Promise.all(priorReaders)

  try {
    return await operation()
  } finally {
    releaseCurrent()
    queue.pendingWriters -= 1
    if (queue.writerTail === currentDone) {
      queue.writerTail = null
    }
    maybeReleaseQueue(key, queue)
  }
}

/**
 * Shared (read) access to a path: waits for every writer queued so far, then
 * runs concurrently with other readers. Writers queued afterwards wait for
 * this read to finish before mutating the file.
 */
export async function withFileReadAccess<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = normalizeQueueKey(filePath)
  const queue = getQueue(key)

  const waitForWriters = queue.writerTail
  let releaseCurrent!: () => void
  const currentDone = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  queue.readers.add(currentDone)

  if (waitForWriters) await waitForWriters

  try {
    return await operation()
  } finally {
    releaseCurrent()
    queue.readers.delete(currentDone)
    maybeReleaseQueue(key, queue)
  }
}

export function getFileMutationQueueSize(): number {
  return queues.size
}

export function clearFileMutationQueuesForTests(): void {
  queues.clear()
}
