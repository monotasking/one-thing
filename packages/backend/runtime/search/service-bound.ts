/**
 * `SearchService` 的**进程单槽**(S2)。
 *
 * 设计:docs/design/search-index-2026-09.md §3(装配在 `backend/wiring/search/index.ts`)。
 *
 * 为什么槽住在产品层而不是装配层:`assembly:gate`(组合根 A3)是**只许降**的棘轮 ——
 * `packages/backend` 里新长出一个模块级 `let` 就是红,而这个槽正是那种「进程里只有
 * 一份」的东西。仓里既有的同款(`plugins/status-bound.ts` / `scratchpad/service-bound.ts`
 * / `tools/background-jobs-bound.ts`)也都住在产品层,文件名 `*-bound.ts` 就是它的角色。
 *
 * 形照 `backend/server/search-providers.ts` 那一对:`configure*` 返回**还原**函数,
 * 装配层 `own()` 它,于是 `backend.dispose()` 把进程放回「没有服务」的样子;后起先落
 * 的两只 backend 也不会互相清槽(身份守卫 `if (service === next)`)。
 */

import type { OnethingSearchService } from './service.js'

let service: OnethingSearchService | null = null

export class OnethingSearchServiceMissingError extends Error {
  constructor() {
    super('search service is not assembled in this process')
    this.name = 'OnethingSearchServiceMissingError'
  }
}

/** 装配点。返回还原函数(只还原自己写的那一次)。 */
export function configureOnethingSearchService(next: OnethingSearchService | null): () => void {
  const previous = service
  service = next
  return () => {
    if (service === next) service = previous
  }
}

/** 没装配就是 `null` —— 调用方自己决定这是降级还是错误。 */
export function getOnethingSearchServiceSafe(): OnethingSearchService | null {
  return service
}

/** 装配过才问得出口;没装配是**结构化的错**,不是一份空结果。 */
export function getOnethingSearchService(): OnethingSearchService {
  if (service === null) throw new OnethingSearchServiceMissingError()
  return service
}

/** 测试专用:把槽放回未装配。 */
export function resetOnethingSearchServiceForTests(): void {
  service = null
}
