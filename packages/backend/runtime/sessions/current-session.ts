/**
 * 「当前会话」的 id:应用状态文件(`<store>/app-state.json`)里的那一格,读写都绑在 store 默认路径上。
 *
 * 包根归位 2(2026-10-03)从包根 `stores/app-state.ts` 搬来。那只文件原本还交出整份应用状态的读写、当前空间
 * id 的读写与两个类型,全仓没有任何使用者,搬家时删掉;读写原语本身在 `runtime/storage/app-state.ts`,
 * 路径在 `runtime/storage/paths.ts`。剩下的两个函数只有会话这边在用(会话表、检索、待办、语音),所以住这里。
 * 每次调用现取路径,加载时什么也不做。
 */
import {
  getOnethingAppStatePath,
  getOnethingCurrentSessionId,
  setOnethingCurrentSessionId,
} from '@onething/backend/runtime/storage'

export function getCurrentSessionId(): string {
  return getOnethingCurrentSessionId(getOnethingAppStatePath())
}

export function setCurrentSessionId(sessionId: string): void {
  setOnethingCurrentSessionId(getOnethingAppStatePath(), sessionId)
}
