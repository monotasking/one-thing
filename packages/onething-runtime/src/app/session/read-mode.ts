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
}
