/**
 * **这一次运行的壳坐标**(第④步批 1,决策 D8 / D277)。每次页面加载现铸一个,不跨重载复用(判词与
 * `resources/shell-host.ts` 的文件头同一句:坐标不是身份,新 id 重新登记是最短的一条路)。
 *
 * 它有两个读者,读的必须是**同一个**值:
 *  · 传输层把它放进每一条请求的 `X-Onething-Shell-Id` 头 —— 后端在 HTTP 边界把它铸进调用上下文的
 *    `callerId`,于是「用户在这扇壳里点出来的那一次请客户端执行」会发回这一扇,不是随便哪一扇;
 *  · `resources/shell-host.ts` 拿它登记这扇壳认领的命名空间。
 */
const shellIdentity: { id?: string } = {}

export function clientShellId(): string {
  shellIdentity.id ??= mintShellId()
  return shellIdentity.id
}

function mintShellId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  // jsdom / 老 WebView 没有 `randomUUID`。坐标只要在这台 core 上唯一即可(形状要过后端那道
  // `[A-Za-z0-9_-]{1,128}` 的判据)。
  return `shell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
