/**
 * **调用方撤回了这一发吗**(09-07 事故第四条修)。
 *
 * 起因是真机上一次搜索起了 31 条 `rg`,清空输入框之后它们照样在 462% CPU 上跑:
 * 壳那边 `AbortController` 一拉,`fetch` 当场把连接拆了 —— 而后端**没有人在看**
 * 那件事,处理者继续算到底。这个文件就是「有人在看」。
 *
 * ## 判据:`response` 的 `close` + `writableEnded === false`
 *
 * 响应还没写完连接就没了 = 对面走了。
 *
 * **不用 `request.on('close')`** —— 自 Node 16 起,请求体读完就会触发它;一个正常的
 * 小 POST(RPC 信封就是)在处理者还没开始干活的时候就会被判成「取消」。这是这套
 * 判据唯一容易写错的地方,所以它住在一个有名字的文件里,而不是散在路由处理者中间。
 *
 * ## 为什么没有 `dispose()`
 *
 * 监听器挂在 `response` 上,而 `response` 的寿命就是这一次请求 —— 请求收尾它一起
 * 被回收,不存在「一条连接积起 n 个监听器」那种泄漏。少一格要记得调的收尾,
 * 就少一种忘记调的方式。
 *
 * ## 它是**加速器**,不是边界
 *
 * 收到就早点收工;收不到,处理者仍然必须自己有边界(检索那一路的边界是能力自述里的
 * `budget.timeoutMs`)。一个不会断的宿主(IPC 直调、单测)根本不铸这一格 ——
 * 缺席 = 「没人能告诉你调用方走了」,不是「调用方还在」。
 */
import type { ServerResponse } from 'node:http'

export function watchClientDisconnect(response: ServerResponse): AbortSignal {
  const controller = new AbortController()
  response.on('close', () => {
    // 正常收尾时 `writableEnded` 已经是 true,所以这只监听器什么都不做。
    if (!response.writableEnded) controller.abort(new Error('client disconnected'))
  })
  return controller.signal
}
