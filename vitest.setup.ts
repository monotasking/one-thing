import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'

// Global test setup.
//
// ── 硬闸:测试进程结构上摸不到真机 store(§16.22)────────────────────────
//
// store 根解析成 `ONETHING_STORE_PATH || ~/.onething`(runtime `storage/paths.ts`),
// 所以**任何**没显式指定 store 的测试默认写的都是用户的真机库。从前靠"每个测试
// 自己换 HOME"来躲,那是纪律不是机制,而且躲不干净:落盘常常是排队异步的,回调
// 跑到时 HOME 早已恢复,字节照样进真机库(事件账本那条已由 event-log.ts 钉死落点
// 根治,但同类通道不止一条)。
//
// 闸门装在 **HOME** 上,不装在 `ONETHING_STORE_PATH` 上,理由是精确的:
//
//  - 装 HOME:默认 store 变成 `<临时 HOME>/.onething`,真机库结构上够不着;而
//    已有那十来个"自己换 HOME 做隔离"的用例**照旧生效**(它们只是把 HOME 从
//    闸门给的临时目录换成自己的临时目录),显式设 `ONETHING_STORE_PATH` 的用例
//    也照旧优先。顺带还盖住了 store 口以外的 home 直拼(rg 二进制目录、
//    login-shell-env 缓存……)。
//  - 装 `ONETHING_STORE_PATH`:env 的优先级高于 home,那十来个用例的换 HOME
//    会当场变成一句空话 —— 隔离没了,它们会共用同一个 worker 库互相串味。
//
// setupFiles 在每个测试文件的模块求值之前跑,所以任何模块级 `getOnething*Path()`
// / `os.homedir()`(Node 的 homedir 读 $HOME)也已经在闸后。
// 逃生口:ONETHING_VITEST_REAL_HOME=1(真机脚本要真 home 时用)。
if (process.env.ONETHING_VITEST_REAL_HOME !== '1') {
  // worker 之间必须互不相干:同一个 worker 进程会顺序跑多个测试文件(env 在
  // 进程里活着),所以粒度就是 worker —— 用 vitest 自己的 worker id,拿不到时
  // 退到 pid。mkdtemp 的随机后缀保证跨轮次也不撞。
  const workerId = process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID || String(process.pid)
  const fakeHome = fs.mkdtempSync(nodePath.join(os.tmpdir(), `onething-vitest-home-w${workerId}-`))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  // 收摊(留档开关:ONETHING_VITEST_KEEP_STORE=1 保留现场)。删不掉不算错 ——
  // 这是清洁,不是断言。
  process.on('exit', () => {
    if (process.env.ONETHING_VITEST_KEEP_STORE === '1') return
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true })
    } catch {
      /* 清洁失败不该把测试判红 */
    }
  })
}
//
// happy-dom's default document origin is http://localhost:3000, so any
// renderer code that fires platformApi web fallbacks (fetch('/api/…') or
// new EventSource('/api/…')) during a component test makes a REAL network
// attempt to that port. The refused connections surface as unhandled
// AggregateErrors that vitest occasionally attributes to whatever test is
// running — a standing source of flaky failures.
//
// Guarded to browser-like environments: node-env tests (server HTTP tests,
// provider tests with their own fetch doubles) keep the real fetch.
if (typeof window !== 'undefined') {
  const offlineFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({ success: false, error: 'Network is disabled in renderer tests.' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  globalThis.fetch = offlineFetch
  window.fetch = offlineFetch

  class OfflineEventSource {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readonly readyState = OfflineEventSource.CLOSED
    onerror: ((event: unknown) => void) | null = null
    onmessage: ((event: unknown) => void) | null = null
    onopen: ((event: unknown) => void) | null = null
    constructor(readonly url: string) {}
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return false
    }
    close(): void {}
  }
  ;(window as { EventSource: unknown }).EventSource = OfflineEventSource
  ;(globalThis as { EventSource: unknown }).EventSource = OfflineEventSource
}

export {}
