/**
 * 开发期深冻结开关 —— docs/design/session-commands-p0-2026-08.md §1。
 *
 * 命令面的纪律是"消息对象一旦从 store 交出去就不许再改"。生产期不冻(深冻结
 * 400 条消息的成本要花在流式热路径上),靠 `bun run session:gate` 守;开发/测试
 * 期可以打开,让漏网的就地改**当场抛 TypeError**,而不是静默生效再在下一次
 * 重建时回滚。
 *
 * 开关口径(单一入口,别在别处再判一次):
 *   - `ONETHING_SESSION_FREEZE=1|true|on` → 开
 *   - `ONETHING_SESSION_FREEZE=0|false|off` → 关
 *   - 缺省:**vitest 下开,其余关**(生产/开发跑 Electron 时不冻)
 *
 * P0.1 实测:vitest 全量在冻结下是绿的(10652 passed),所以默认就开着 —— 但要
 * 清醒地记着这份绿的含金量有限:core 引擎的已知就地改点(tool-orchestration /
 * agent-loop-executor / stream-processor、core/engine/history)在单测里拿的是
 * mock store,冻不到。真正的验收在 P0.2:调用点迁完后每区都要在冻结下跑全量。
 */
import { deepFreeze } from '@onething/core/session'

const TRUTHY = new Set(['1', 'true', 'on', 'yes'])

const FALSY = new Set(['0', 'false', 'off', 'no'])

function readEnvFlag(): boolean {
  const env = typeof process !== 'undefined' ? process.env : undefined
  const raw = env?.ONETHING_SESSION_FREEZE
  if (raw) {
    const value = raw.trim().toLowerCase()
    if (TRUTHY.has(value)) return true
    if (FALSY.has(value)) return false
  }
  return Boolean(env?.VITEST)
}

let enabled = readEnvFlag()

export function isSessionFreezeEnabled(): boolean {
  return enabled
}

/** 测试用:临时打开/关闭(不改环境变量)。 */
export function setSessionFreezeEnabled(next: boolean): void {
  enabled = next
}

/**
 * 从 store 交出去的会话:把**消息对象**冻住(容器与 messages 数组不冻 —— 那两样
 * 由命令面整体替换,冻了反而挡住命令面自己)。
 *
 * P0.4:这段原来住在 `app/stores/sessions.ts`,那是唯一让它持有 `session.messages`
 * 的理由 —— 而 stores 按设计不在白名单里。搬到这里之后入参是**鸭子形状**
 * (只要求一个 `messages` 袋子),既不是会话读也不需要开白名单。
 */
export function guardFrozenSessionMessages<
  TSession extends { messages?: readonly unknown[] },
>(session: TSession | undefined): TSession | undefined {
  if (!session || !enabled) return session
  const messages = session.messages
  if (Array.isArray(messages)) {
    for (const message of messages) deepFreeze(message)
  }
  return session
}

/** 同上,但直接给一串消息(store 的 `getSessionMessages` 用)。 */
export function guardFrozenMessages<TMessage>(
  messages: TMessage[] | undefined,
): TMessage[] | undefined {
  if (!messages || !enabled) return messages
  for (const message of messages) deepFreeze(message)
  return messages
}
