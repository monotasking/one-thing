import { browserPort } from './browser-port'

/**
 * **在文件管理器里定位一条路径**(B3-a 第一个消费者:下载落地那一行)。
 *
 * ── 它走的是 `dir:` 那条**已有**的做法,不是一条新的壳通道 ─────────────────
 * `dir` 那份自述里早就有 `reveal`(`packages/onething-runtime/src/files/resource-spec.ts`:
 * 零效果、`home: 'core'`、走主进程的 `shell.showItemInFolder`)。AI 要定位一条路径
 * 走的就是它 —— 壳再开一条 RPC 等于同一件事两条路(音乐面板判例)。
 *
 * ── 它为什么住在这只文件里,而不是 `browser-source.ts` ────────────────────
 * 因为它**与浏览器无关**:定位一条路径是这台壳里任何一块面都可能要的动作
 * (文件树、附件、将来的导出)。今天只有一个消费者,而那不是把它写进浏览器数据层
 * 的理由 —— 写进去之后,第二个消费者只能 import 一只叫「浏览器」的模块来定位
 * 一个与浏览器无关的文件。
 *
 * ── 沙箱:下载目录**在读根里** ────────────────────────────────────────────
 * `dir` 的 `reveal` 走的是**读根**(`sandbox.readable`)—— 那一根界的原话是
 * 「写根并上用户亲手接入的目录、笔记根、**下载目录**」。所以下到下载目录里的东西
 * 定位得到。落在读根之外的路径会得到一句结构化的越界拒绝,**不是崩溃**:
 * 这只函数把它原样交出去,由调用方决定说什么。
 */

/** `dir:` 的地址(`<scheme>:<path>`,内核在第一个冒号处切,路径里的斜杠不碍事)。 */
export function dirRef(path: string): string {
  return `dir:${path}`
}

/**
 * 定位一条路径。**答一句错话或 `null`** —— 不抛:调用方是一行读数,它要的是
 * 「说得出口的一句话」而不是一个要包 try 的异常。
 */
export async function revealPath(path: string): Promise<string | null> {
  if (!path) return null
  const port = await browserPort()
  const outcome = await port.do(dirRef(path), 'reveal', {})
  switch (outcome.kind) {
    case 'ok':
      return null
    case 'invalid':
      return outcome.message
    case 'denied':
      return outcome.reason
    case 'aborted':
      return outcome.reason ?? null
    case 'failed':
      return outcome.error.message
    default:
      return null
  }
}
