/**
 * **网页权限从「缺省全拒」改成「问一次」**(B3-a;B1-a 的 `session-policy.ts`
 * 文件头写着「改成按域询问是 B3」,这只文件就是那一单)。
 *
 * ## 为什么 B1-a 当时必须全拒,而现在可以问
 *
 * 那时候壳里没有那张询问面,于是 `callback(true)` 会是**一次谁都没看见的授权**。
 * 今天壳里有了(`content/permission/WebPermissionCard.tsx`,复用既有权限卡的形),
 * 所以「问」这条路才第一次成立。缺省拒从来不是保守,是诚实 —— 没人能答的时候,
 * 唯一诚实的答案就是不。
 *
 * ## 三档,而分档的判据是**这一格权限答错了会怎样**
 *
 *   · **可询问**(下表 `ASKABLE`)—— 答错的后果人自己担得起,而且**页面自己会
 *     处理被拒**:`getCurrentPosition` 有 error 回调、`Notification.requestPermission`
 *     有返回值、`getUserMedia` 会 reject。这一族交给人;
 *   · **一律拒**(其余每一格,含 `display-capture` / `fullscreen` / `openExternal`)
 *     —— 三条理由各不相同,但都不是「问一下」能解决的:
 *       `display-capture` 要一张选源面(选哪扇窗 / 哪块屏),那是一整套 UI,
 *       今天没有,拿一张「允许 / 拒绝」去代替等于让人在不知道会录到什么的情况下答应;
 *       `fullscreen` 的全屏是**这扇 app 窗**的全屏,而窗归壳管(拼贴树、浮窗、
 *       钉边都在算它的矩形)—— 一个网页把宿主窗弄成全屏,壳那一侧的几何当场说谎;
 *       `openExternal` 是把请求交给别的应用,与 `isAllowedNavigation` 拦非 http(s)
 *       是同一条判例(「一个网页把用户悄悄踢出 app,是它自己就不该做到的事」);
 *   · **认不出来的**(`unknown`,以及 Electron 将来新加的每一格)—— 拒。表里没有
 *     就是没有:让一格没人想过的权限默认能问,等于把这张表的判据交给上游的版本号。
 *
 * ## 60 秒之后视为拒,而且**那一下也是一条事实**
 *
 * 一次 `setPermissionRequestHandler` 的 `callback` 不调,页面那边就永远悬着
 * (`getCurrentPosition` 的两个回调一个都不来)。所以超时必须有一个默认答案,而
 * 默认答案只能是拒。超时同时发一条 `permissionResolved` —— 不发的话壳上那张卡
 * 会永远举着,而它问的那件事其实早就结了。同一条事件也兼着「另一扇窗答掉了」
 * 与「这一格 tab 关掉了」两种收场(`withdrawTab`)。
 *
 * ## 零 electron import(DIP)
 *
 * 它只认识两只注入的端口(发事实、计时)。于是「哪一族能问」「超时真的拒」
 * 「答完不会再答第二遍」这三件真会出错的事在 vitest 里量得到,一个 Electron
 * 运行时都不用起。
 */

/** 一格权限的判决。表里没有的一律 `deny`。 */
export type WebPermissionVerdict = 'ask' | 'deny'

/**
 * 可以问的那一族(Electron 的权限名,原样)。
 *
 * `media` 一格同时盖着摄像头与麦克风 —— Electron 不拆,`details.mediaTypes` 才拆。
 * 本单**不按 mediaTypes 分档**:卡上那句话照实说「摄像头 / 麦克风」,拆成两句是
 * 一次文案分档,而后端这一侧一个字都不用改(留账)。
 */
export const ASKABLE_WEB_PERMISSIONS: readonly string[] = [
  'notifications',
  'geolocation',
  'media',
  'clipboard-read',
  'midi',
  'pointerLock',
]

const ASKABLE = new Set(ASKABLE_WEB_PERMISSIONS)

/**
 * 这一格权限该问还是该拒。**纯函数** —— 三档的判词在文件头,这里只有一句实现。
 */
export function decideWebPermission(permission: string): WebPermissionVerdict {
  return ASKABLE.has(permission) ? 'ask' : 'deny'
}

/** 超时:到点视为拒。60s 是「人离开座位去倒杯水」那个量级。 */
export const WEB_PERMISSION_TIMEOUT_MS = 60_000

/** 一次询问对外说的那一句(装配点转手发成资源事件)。 */
export interface WebPermissionAskEvent {
  readonly tabId: string
  readonly requestId: string
  readonly permission: string
  readonly origin: string
}

/** 一次询问的收场。`reason` 说的是**谁结的**,不是答案本身。 */
export interface WebPermissionResolvedEvent {
  readonly tabId: string
  readonly requestId: string
  readonly allow: boolean
  readonly reason: 'answered' | 'timeout' | 'gone'
}

export interface WebPermissionBrokerDeps {
  /** 有人在问。装配点把它发成 `permissionRequested`。 */
  readonly onAsk: (event: WebPermissionAskEvent) => void
  /** 结了。装配点把它发成 `permissionResolved`。 */
  readonly onResolved: (event: WebPermissionResolvedEvent) => void
  /** 测试缝:换掉计时器与 id。 */
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly mintId?: () => string
  readonly timeoutMs?: number
}

interface Pending {
  readonly tabId: string
  readonly settle: (allow: boolean) => void
  timer: unknown
}

export class WebPermissionBroker {
  private readonly deps: WebPermissionBrokerDeps
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private disposed = false

  constructor(deps: WebPermissionBrokerDeps) {
    this.deps = deps
  }

  /** 只给测试与诊断:此刻还有几问悬着。 */
  get pendingCount(): number { return this.pending.size }

  /**
   * 问一次。答案是一个 Promise —— `setPermissionRequestHandler` 的 `callback`
   * 由调用方在它 resolve 之后调。
   *
   * **已经在关的这台 broker 一律答拒**:退出那一路上冒出来的一次询问没人会看见,
   * 而悬着不答会让页面那边永远等。
   */
  ask(request: { tabId: string; permission: string; origin: string }): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const requestId = this.deps.mintId?.() ?? `perm-${(this.seq += 1)}`
    return new Promise<boolean>(resolve => {
      let done = false
      const settle = (allow: boolean): void => {
        if (done) return
        done = true
        resolve(allow)
      }
      const entry: Pending = { tabId: request.tabId, settle, timer: undefined }
      this.pending.set(requestId, entry)
      const setTimer = this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
      entry.timer = setTimer(() => {
        this.finish(requestId, false, 'timeout')
      }, this.deps.timeoutMs ?? WEB_PERMISSION_TIMEOUT_MS)
      // `unref` 让一问悬着的时候进程照样退得掉。不是所有计时器都有它(测试缝)。
      ;(entry.timer as { unref?: () => void } | undefined)?.unref?.()
      this.deps.onAsk({ tabId: request.tabId, requestId, permission: request.permission, origin: request.origin })
    })
  }

  /**
   * 人答了。
   *
   * 认不出的 `requestId` **答 false 而不是抛** —— 它的常态是「这一问已经超时结了,
   * 而壳那张卡还在人手上」,那不是一次错误,是两边差一拍。调用方据此答得出一句
   * 说得出口的话。
   */
  respond(requestId: string, allow: boolean): boolean {
    return this.finish(requestId, allow, 'answered')
  }

  /** 这一格 tab 没了:它身上还悬着的每一问当场按拒结掉。 */
  withdrawTab(tabId: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.tabId === tabId) this.finish(requestId, false, 'gone')
    }
  }

  /** 关张。悬着的全部按拒结掉(理由同 `ask` 的那一句)。幂等。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const requestId of [...this.pending.keys()]) this.finish(requestId, false, 'gone')
  }

  private finish(requestId: string, allow: boolean, reason: WebPermissionResolvedEvent['reason']): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    const clearTimer = this.deps.clearTimer ?? ((handle: unknown) => { clearTimeout(handle as never) })
    clearTimer(entry.timer)
    entry.settle(allow)
    this.deps.onResolved({ tabId: entry.tabId, requestId, allow, reason })
    return true
  }
}
