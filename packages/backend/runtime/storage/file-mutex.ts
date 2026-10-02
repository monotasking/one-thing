import fs from 'node:fs'
import path from 'node:path'

/**
 * 跨进程同步文件互斥锁:短持有、可竞争、退避重试。
 *
 * 用于让多个协作进程(如 Electron 主进程与 headless server)对同一个共享文件做
 * 原子的读-改-写(典型:sessions/index.json),避免 last-writer-wins 丢更新。
 *
 * 设计取舍:
 * - 同步实现,持锁只覆盖一次同步 RMW 的几毫秒,避免把 async 传染到全部调用方。
 * - 竞争时用 Atomics.wait 退避(阻塞事件循环,但有界且罕见)。
 * - 进程内可重入(计数),防止嵌套 RMW 与自己的锁死锁。
 * - holder 进程已死则偷锁,防崩溃残留永久卡死。
 * - 超时默认「降级放行」而非抛错:锁是尽力而为的串行化器,永不阻断功能;
 *   极端竞争下退回到无锁行为(与今天一致),严格不劣化。
 */

export interface FileLockOptions {
  /** 竞争时的总等待预算(毫秒),超时后按 onTimeout 处理。默认 2000。 */
  timeoutMs?: number
  /** 每次重试的退避间隔(毫秒)。默认 10。 */
  retryMs?: number
  /** 超时行为:'proceed' 记录告警后无锁执行(默认);'throw' 抛错。 */
  onTimeout?: 'proceed' | 'throw'
  /** 可选标识,写进锁文件便于诊断。 */
  owner?: string
  logger?: { warn?(...args: unknown[]): void }
}

interface LockMeta {
  pid: number
  acquiredAt: number
  owner?: string
}

// 进程内重入深度:lockPath -> depth
const heldDepth = new Map<string, number>()

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleepSync(ms: number): void {
  // 阻塞当前线程 ms 毫秒且不空转 CPU(nobody notifies -> 必然按超时返回)。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readLockMeta(lockPath: string): LockMeta | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim()
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<LockMeta>
    if (typeof value.pid !== 'number') return null
    return {
      pid: value.pid,
      acquiredAt: typeof value.acquiredAt === 'number' ? value.acquiredAt : 0,
      owner: typeof value.owner === 'string' ? value.owner : undefined,
    }
  } catch {
    return null
  }
}

/**
 * 原子创建带完整 meta 的锁文件:先写临时文件,再 link 到锁路径。
 * link 是原子的 create-or-EEXIST,锁文件一出现就带内容——消除了
 * 「open('wx') 之后、写 meta 之前」锁文件为空、被并发方误判为损坏锁
 * 而 unlink 掉活锁的窗口(实测会造成双持锁丢更新)。
 */
function tryCreateLockFile(lockPath: string, owner?: string): boolean {
  const payload = JSON.stringify({
    pid: process.pid,
    acquiredAt: Date.now(),
    owner,
  } satisfies LockMeta)
  const tmpPath = `${lockPath}.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, payload)
  try {
    fs.linkSync(tmpPath, lockPath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    // 个别文件系统不支持硬链接:退回旧的 wx 两步创建(保留极窄空窗,
    // 好过直接失败)。
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(fd, payload)
      } finally {
        fs.closeSync(fd)
      }
      return true
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw fallbackError
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // 尽力清理。
    }
  }
}

function lockFileAgeMs(lockPath: string): number {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** 尝试拿锁;成功返回 true,超时返回 false(不抛)。 */
function acquire(lockPath: string, timeoutMs: number, retryMs: number, owner?: string): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (tryCreateLockFile(lockPath, owner)) return true

    // 已被占用:holder 死了则偷锁重试。meta 读不出时不能立刻断定损坏——
    // 旧版两步创建的写方可能正处在空窗中,给一个 mtime 宽限期再清理。
    const meta = readLockMeta(lockPath)
    const isDeadHolder = meta ? !isProcessAlive(meta.pid) : lockFileAgeMs(lockPath) > 1000
    if (isDeadHolder) {
      // 偷锁前复读:锁若已换手(别人清掉死锁并重建),不能删新持有者的锁。
      const recheck = readLockMeta(lockPath)
      if (recheck && meta && recheck.pid !== meta.pid) continue
      try {
        fs.unlinkSync(lockPath)
      } catch {
        // 被别的进程抢先清理,直接重试。
      }
      continue
    }

    if (Date.now() >= deadline) return false
    sleepSync(retryMs)
  }
}

function releaseFile(lockPath: string): void {
  try {
    const meta = readLockMeta(lockPath)
    // 只删自己持有的锁,避免误删偷锁后别人重建的锁。
    if (!meta || meta.pid === process.pid) {
      fs.unlinkSync(lockPath)
    }
  } catch {
    // 尽力而为。
  }
}

/**
 * 在跨进程文件锁保护下同步执行 fn,并返回其结果。
 * 同进程重入安全;超时按 onTimeout 处理(默认降级为无锁执行)。
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, options: FileLockOptions = {}): T {
  const depth = heldDepth.get(lockPath) ?? 0
  if (depth > 0) {
    // 本进程已持锁,重入:仅计数,不再碰锁文件。
    heldDepth.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      const next = (heldDepth.get(lockPath) ?? 1) - 1
      if (next <= 0) heldDepth.delete(lockPath)
      else heldDepth.set(lockPath, next)
    }
  }

  const timeoutMs = options.timeoutMs ?? 2000
  const retryMs = options.retryMs ?? 10
  const acquired = acquire(lockPath, timeoutMs, retryMs, options.owner)

  if (!acquired) {
    if (options.onTimeout === 'throw') {
      throw new Error(`withFileLockSync: timed out acquiring ${lockPath}`)
    }
    options.logger?.warn?.(
      `[file-mutex] timed out acquiring ${lockPath}; proceeding without lock (best-effort)`,
    )
    return fn()
  }

  heldDepth.set(lockPath, 1)
  try {
    return fn()
  } finally {
    const next = (heldDepth.get(lockPath) ?? 1) - 1
    if (next <= 0) {
      heldDepth.delete(lockPath)
      releaseFile(lockPath)
    } else {
      heldDepth.set(lockPath, next)
    }
  }
}
