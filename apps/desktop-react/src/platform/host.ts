/**
 * **宿主能力** —— 不经 core 就能答的那些(C1,`docs/design/client-sdk-2026-09.md` §4.3)。
 *
 * 判据只有一句:**凡是不经 core 就能答的,不进 `@onething/backend-client`**。系统明暗
 * (`matchMedia`)、剪贴板、打开外链、文件对话框都归这里 —— 它们是**这台宿主**
 * 的能力,不是「core 的客户端」的一格。把它们塞进客户端包会立刻把浏览器全局
 * 拖进 Node(CLI 用同一个包),而那正是包边界门禁掉的东西。
 *
 * 今天只有一格:系统明暗。它此前借道 Vue 渲染层那份 platform 的 web 实现
 * (`onSystemThemeChanged` 是一条 `prefers-color-scheme` 的 matchMedia 监听,
 * `settingsApi.getSystemTheme` 在 `environment === 'web'` 那一支同样只读
 * matchMedia,一个字节的网都不碰)。**行为逐字照搬**:同一个媒体查询、同一个
 * 「读不到就当 dark」的兜底、同一个「没有 matchMedia 就交一个 noop 退订」。
 *
 * 第④步批 1 起这里多了**第二格:只在用户屏幕上发生的事**(决策 D278 / D280)—— 原生打开对话框、
 * 把网址交给系统浏览器、用默认程序打开一个本地路径、在文件管理器里定位一个路径。它们从前经后端绕一圈
 * (`dialog` / `shell` 两个 RPC 域);现在桌面经 preload 的 `host:client-action` 交给主进程,
 * 浏览器壳(以及将来的手机)没有那条口。
 *
 * **「这台客户端做不做得到」只有一个判据:preload 上有没有 `clientAction`**(`canRunClientActions()`)。
 * 按钮画不画、一次调用答不答「这台客户端做不了」,都从它推,不另立第二个 flag;后端的
 * `GET /api/capabilities` 不管这件事(它答不出「问的是哪台客户端」)。
 */
import type {
  ClientActionBridge,
  ClientActionDone,
  ShowOpenDialogRequest,
  ShowOpenDialogResponse,
} from '@shared/contracts/client-action'

/**
 * 此刻的系统明暗。
 *
 * 口径与产地(`packages/renderer/platform/web.ts` 的 `getPreferredColorScheme`)
 * 逐字相同:问的是 **light**,问不出来就当 dark —— 「读不到」与「用户选了浅色」
 * 是两件事,兜底只能倒向其中一件,这台壳一直倒向 dark。
 */
export function systemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * 订系统明暗的变化。返回退订函数。
 *
 * 监听挂在 `(prefers-color-scheme: dark)` 上而读数走 `systemTheme()`(问 light)——
 * 这不是笔误,是产地原样:两个查询是同一件事的两面,变一次两边都会响,
 * 而读数只认一个产地。没有 `matchMedia`(jsdom 默认、老 WebView)时交一个
 * noop 退订:**订不上就是订不上**,不假装订上了再永远不响。
 */
export function onSystemThemeChanged(
  callback: (theme: 'light' | 'dark') => void,
): () => void {
  const media
    = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: dark)')
  if (!media) return () => {}
  const listener = (): void => callback(systemTheme())
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

/* ── 第二格:只在用户屏幕上发生的事 ─────────────────────────────────────── */

function clientActionBridge(): ClientActionBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const host = (window as unknown as { onethingHost?: { clientAction?: unknown } }).onethingHost
  return typeof host?.clientAction === 'function' ? (host.clientAction as ClientActionBridge) : undefined
}

/**
 * 这台客户端能不能在用户屏幕上开对话框、打开本地路径、在访达里定位。**唯一判据**(见文件头)。
 * 浏览器壳答 `false`:那几颗按钮不画。
 */
export function canRunClientActions(): boolean {
  return clientActionBridge() !== undefined
}

/**
 * 打开 / 定位一个本地路径的结局。`unsupported` = 这台客户端做不了(浏览器壳、手机),调用方说一句
 * 结构化的话或者干脆不画那颗按钮,**不许静默无反应**。
 */
export type LocalPathOutcome =
  | { ok: true }
  | { ok: false; reason: 'unsupported' }
  | { ok: false; reason: 'failed'; error: string }

async function runPathAction(kind: 'openPath' | 'revealPath', path: string): Promise<LocalPathOutcome> {
  const bridge = clientActionBridge()
  if (!bridge) return { ok: false, reason: 'unsupported' }
  try {
    const done: ClientActionDone = await bridge({ kind, path })
    return done.ok ? { ok: true } : { ok: false, reason: 'failed', error: done.error }
  } catch (error) {
    return { ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/** 用默认程序打开一个绝对路径(目录 = 在文件管理器里打开它)。 */
export function openLocalPath(path: string): Promise<LocalPathOutcome> {
  return runPathAction('openPath', path)
}

/** 在文件管理器里定位一个绝对路径(macOS 的「在访达中显示」)。 */
export function revealLocalPath(path: string): Promise<LocalPathOutcome> {
  return runPathAction('revealPath', path)
}

/**
 * 原生打开对话框。没有这条口的客户端答 `unavailable: true`(调用方据它退到路径输入框,不当作取消)。
 */
export async function showNativeOpenDialog(request: ShowOpenDialogRequest): Promise<ShowOpenDialogResponse> {
  const bridge = clientActionBridge()
  if (!bridge) return { canceled: true, filePaths: [], unavailable: true }
  return bridge({ kind: 'showOpenDialog', request })
}

/**
 * 把网址交给系统浏览器(只给 `platform/open-external.ts` 用 —— 它还管着浏览器壳那一支)。
 * 没有这条口 = `undefined`,由调用方走自己的退路。
 */
export async function openExternalViaHost(url: string): Promise<ClientActionDone | undefined> {
  const bridge = clientActionBridge()
  if (!bridge) return undefined
  return bridge({ kind: 'openExternal', url })
}
