/**
 * 读模式开关(S2a,`docs/design/session-event-sourcing-2026-08.md` §11.1)。
 *
 *   `ONETHING_SESSION_READ = 'messages'(默认) | 'events'`
 *
 * **默认不变**:仍读 `messages.jsonl`。S2a 只把事件那条读路径建起来并放在
 * 开关之后;切默认是 S2b,要用户拍板。
 *
 * 单一入口的理由与 `event-stats.ts` 的总闸相同:一个"现在读的是哪一边"的
 * 问题在代码里只该有一个答案。测试用 `setSessionReadModeForTesting` 临时切,
 * 不去改进程环境变量(vitest 是同进程并发的,改 env 会串台)。
 */

export type SessionReadMode = 'messages' | 'events'

export const DEFAULT_SESSION_READ_MODE: SessionReadMode = 'messages'

let override: SessionReadMode | undefined
let foreignCoreWarned = false

function fromEnv(): SessionReadMode {
  const raw = process.env.ONETHING_SESSION_READ?.trim().toLowerCase()
  return raw === 'events' ? 'events' : DEFAULT_SESSION_READ_MODE
}

export function getSessionReadMode(): SessionReadMode {
  return override ?? fromEnv()
}

export function isSessionEventsReadMode(): boolean {
  return getSessionReadMode() === 'events'
}

/** 仅测试:临时切读模式;传 `undefined` 归还给环境变量。 */
export function setSessionReadModeForTesting(mode?: SessionReadMode): void {
  override = mode
  foreignCoreWarned = false
}

/**
 * R-c(§13.6):**切读之前先问一句这个 store 还有没有别的 core。**
 *
 * `events` 模式下产品线的历史来自 `events.jsonl`。两个写者同时往它追加时,
 * seq 是各自内存里数出来的 —— 会撞号,而 `surfaceOp: replace` 引用的正是 seq,
 * 于是遮蔽区间指向别人的事件,校验还照样放行(surface 上确实有那个 seq)。
 * 迁移脚本对这件事是**硬拦**(它要重编号整份文件);这里只**喊一声**:
 * 已经开着的桌面不该因为一个环境变量而崩掉,而 server 撤锁的裁定仍然成立。
 *
 * 每进程喊一次(启动期调一次就够,喊多了没人看)。
 *
 * @param foreignCore 宿主查出来的"另一个 core"(`run/http.json` 里那位)。
 */
export function warnOnForeignCoreForEventsRead(
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  foreignCore: { owner?: string; pid?: number; port?: number } | undefined,
): void {
  if (!foreignCore) return
  if (!isSessionEventsReadMode()) return
  if (foreignCoreWarned) return
  foreignCoreWarned = true
  log.warn('events read mode with another live core on this store', {
    owner: foreignCore.owner,
    pid: foreignCore.pid,
    port: foreignCore.port,
    why: 'two writers mint the same event seq; replace ops then shadow the wrong range',
  })
}
