import { sessionsRouter, type GetSessionTokenUsageResponse } from '@shared/ipc/sessions'
import { usageRouter, type GetSessionUsageResponse } from '@shared/ipc/usage'

/**
 * 读数(context / tokens / 费用 / 缓存)与 core 的客户端(`@onething/client`)
 * 之间的那一层**端口** —— 与 `data/models-port.ts` 同一形状、同一理由。
 *
 * 两口,恰好是这四行读数的**两个真产地**:
 *  - `usageRouter` 的 `usage.getSession` —— 计费账本(tokens 六格 + 三种成本);
 *    C1 核账结论:这一条**早就有 router**(`@shared/ipc/usage.ts`,后端
 *    `packages/backend/rpc/domains/usage.ts` 已注册),Vue 那侧的
 *    `platformApi.getSessionUsage` 本来就是它的一行别名 —— 所以本批**不加新域**,
 *    方案 §9 那条「没有 router 就加」的账在这里结清:它有。
 *  - `sessionsRouter` 的 `sessions.getTokenUsage` —— 会话上的 token 读数
 *    (contextSize / lastInputTokens / maxTokens)。
 *
 * 第三个产地(模型窗口)**不在这条端口上**:它是 provider 目录里的
 * `context_length`,归 models-source 管(`contextWindowOf`)。同一个数字有两个
 * 取数口就会有两份缓存,而其中一份一定会陈。
 *
 * ── 留账:窗口上限不问 `SessionTokenUsageReadout.maxTokens` ───────────────
 * 那一格也叫 max,但它不是「这个模型的上下文窗口」——读数环画的是
 * 「这一轮送进去的 token 占模型窗口的几成」,窗口的产地只有 provider 目录一个。
 */
export interface MeterPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 这条会话的计费账本。**没有 success 标**:失败是抛出来的,调用方兜。 */
  getSessionUsage(sessionId: string): Promise<GetSessionUsageResponse>
  /** 这条会话的 token 读数。 */
  getTokenUsage(sessionId: string): Promise<GetSessionTokenUsageResponse>
}

let port: MeterPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureMeterPort(next: MeterPort | undefined): void {
  port = next
}

/** 真实现是**惰性**建的,理由与 sessions-port 逐字相同。 */
async function realPort(): Promise<MeterPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const usageApi = client.api(usageRouter)
  const sessionsApi = client.api(sessionsRouter)
  return {
    ready: () => whenConnected(),
    getSessionUsage: (sessionId) => usageApi.getSession({ sessionId }),
    getTokenUsage: (sessionId) => sessionsApi.getTokenUsage({ sessionId }),
  }
}

let pending: Promise<MeterPort> | undefined

export function meterPort(): Promise<MeterPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
