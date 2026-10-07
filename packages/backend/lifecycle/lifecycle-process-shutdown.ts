/**
 * 「请这个进程退出」的那一格(第④步批 3)。
 *
 * 只有独立后端进程的入口(`backend-standalone-main.ts`)知道怎么体面地退出:等后端拆除跑完、会话落盘、再
 * `process.exit`。`backend.shutdown` 这条 RPC 不该自己去 `process.exit`(那会跳过落盘),也不该在进程内嵌的
 * 后端上把宿主进程一起带走 —— 所以进程入口在起来时把自己的收尾函数登记在这里,RPC 只问这一格:登记过就请它收尾,
 * 没登记 = 这台后端不是一只独立进程,答「不归这条命令停」。
 *
 * 单槽、可还原(与宿主端口同一个形:`configure*` 旁边有 `reset*`);状态在一只 `const` 持有器里,不用模块级 `let`。
 */

/** 进程入口登记的收尾函数:收到就开始退出,返回值不等。 */
export type ProcessShutdownRequester = (reason: string) => void

const slot: { requester: ProcessShutdownRequester | undefined } = { requester: undefined }

/** 进程入口起来时登记。返回还原函数(测试与重复登记用)。 */
export function configureProcessShutdownRequest(requester: ProcessShutdownRequester): () => void {
  slot.requester = requester
  return () => {
    if (slot.requester === requester) slot.requester = undefined
  }
}

export function resetProcessShutdownRequest(): void {
  slot.requester = undefined
}

/** 这个进程是不是一只登记过收尾函数的独立后端进程。 */
export function canRequestProcessShutdown(): boolean {
  return slot.requester !== undefined
}

/** 请进程收尾。没登记过 = `false`,什么都不做。 */
export function requestProcessShutdown(reason: string): boolean {
  const requester = slot.requester
  if (!requester) return false
  requester(reason)
  return true
}
