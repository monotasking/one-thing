import type { OnethingClient } from '@onething/client'
import type { RouteAPI } from '@onething/core/ipc'
import type { ResourcesRoutes, ShellCommandResult } from '@shared/ipc/resources'
import { resourcesRouter } from '@shared/ipc/resources'
import { getLogger } from '../services/log'
import { useWorkbenchStore } from '../workbench/store'
import { flattenContent, refId } from '../workbench/kinds'
import { leavesOf } from '../workbench/tree'
import { regionReadRank } from '../workbench/regions'
import { WORKBENCH_SCHEME, workbenchResourceSpec } from './workbench-spec'
import { readWorkbench, runWorkbenchOp } from './shell-ops'

const log = getLogger('resources.shell')

/**
 * **这扇壳把自己交给 core 的那一整段生命**(原子 K2b-2b,正本
 * `docs/design/atom-2026-09.md` §5 / §10.2 / §10.3)。
 *
 * 一个实例 = 一扇壳的一整段连接:登记自述 → 续命 → 收命令、跑、回执 → 报事实 →
 * 注销。**模块级零副作用**:import 这只文件什么都不会发生,一切在实例上;
 * 底下那个 `startShellResources()` 是唯一的挂载点(与 `content/session-projection.ts`
 * 逐字同一个体例,连 HMR dispose 那一段都是同一句)。
 *
 * ## §10.2 在 `workbench` 上的填法(四格)
 *
 * | 状态 | 进入 | 离开 | 期间 |
 * | --- | --- | --- | --- |
 * | 未登记 | 壳还没连上 / 已注销 | `start()` 的那次 `mountShell` | `do(workbench:…)` → `ResourceSchemeUnknownError` |
 * | 已登记 | `mountShell` 答 `{ok:true}` | `stop()` / 关窗 / 心跳过期 | AI 工具面、`describe`、命令面板都看得见它 |
 * | 在飞 | 一条 `resource:shell-command` 到了 | 那条 `shellResult` | 关窗撞上在飞 → core 侧 `ResourceHomeUnavailableError` |
 * | 已注销 | `unmountShell` / 90s 没续命 | — | 再来的调用回到「未登记」那一行 |
 *
 * ## `shellId` 每次运行现铸一个,**不跨重连复用**
 *
 * 一个存进 localStorage、跨重启复用的 id 听起来更省事,实际上更糟:后端那套心跳
 * 兜底(30s 续命 / 90s 没续命就注销)在断线之后会把旧 id 当过期注销掉,而它注销的
 * 是**整批** scheme。壳带着同一个 id 回来时,它要么撞上一个还没被扫掉的旧登记
 * (于是「同 shellId 重 mount」走幂等续命,交上去的自述其实来自上一次运行),
 * 要么撞上一个刚被扫掉的空壳。两种都要写一段「我这次和上次是不是同一扇窗」的
 * 判据,而那个判据没有任何人需要:**新 id 重新 mount 是最短的一条路**,旧的那批
 * 由心跳自己收尸。id 是**坐标不是身份**(契约头注释原话),坐标可以换。
 *
 * ## 断线那一段:命令就是丢了,这是设计
 *
 * 全局事件不进任何环形缓冲、`?after=` 不回放(`global-event-delivery.ts` 纪律 2)。
 * 所以壳断线那一瞬发出的命令没有人会执行 —— 它由 core 那一侧的超时兜住,落成
 * `ResourceHomeUnavailableError`。壳这边**不补**:补它要为每一种全局事件存一本
 * 回放账,而那是给一个已经有答案的问题造第二个答案。
 */

/** 续命周期。后端 `DEFAULT_SHELL_HEARTBEAT_MS` 是 30s、3 倍没续命就注销 —— 对齐它。 */
export const SHELL_HEARTBEAT_MS = 30_000

/**
 * 记住多少条已经跑过的 `callId`。
 *
 * 这张表挡的是「同一条命令被投递两次」。今天投递不会重复(全局事件不回放),所以
 * 它是**结构性的幂等**而不是一道在挡什么的闸;正因为如此,它**可以**有上限:
 * 一条被记了很久之后才重放的命令在 core 那边早就超时收场了,再跑一次也没有收件人。
 */
const HANDLED_CALLS_CAP = 256

/** 事件载荷 → 这扇壳该不该管。名字与形都对得上才算数(SSE 是广播)。 */
interface ShellCommandFrame {
  shellId: string
  callId: string
  kind: 'op' | 'read'
  ref: string | null
  op: string
  params: Record<string, unknown>
}

function asCommand(data: unknown): ShellCommandFrame | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.shellId !== 'string' || typeof row.callId !== 'string') return null
  if (row.kind !== 'op' && row.kind !== 'read') return null
  if (typeof row.op !== 'string') return null
  return {
    shellId: row.shellId,
    callId: row.callId,
    kind: row.kind,
    ref: typeof row.ref === 'string' ? row.ref : null,
    op: row.op,
    params: row.params && typeof row.params === 'object' ? (row.params as Record<string, unknown>) : {},
  }
}

/** `workbench:center` → `center`;整个命名空间(`ref` 为 null)→ 空串。 */
function pathOf(ref: string | null): string {
  if (!ref) return ''
  const at = ref.indexOf(':')
  return at < 0 ? '' : ref.slice(at + 1)
}

/**
 * **此刻这台拼贴台摆着什么**:内容 refId → 它坐在哪个区域。
 *
 * 两条判据写在这里,因为它们是 `opened` / `closed` 那两条事实的定义:
 *
 *  · **摊开复合**(`flattenContent`)—— 一格二合一里的两条会话都是「开着的」,
 *    与 `tree.seatOfRefIn` 逐字同源。少了这一句,「在右侧打开」会读成
 *    「关掉了两格、开了一格 `pair:`」。
 *  · **隐藏不算关闭** —— `hideTab` 明说实例留着、`returnTo` 记着,它是位置记忆
 *    这套机制的内部状态,不是「这格内容没了」。§10.4 那张表里「运行中」问的是
 *    「有没有打开中的实例」,一块收进 Dock 的面板显然还在运行。真正的关闭是
 *    `closeTab` / `dropHidden` / `detachRef`,那三条都会让它从这张表里消失。
 */
function openPlaces(): Map<string, string> {
  const st = useWorkbenchStore.getState()
  const places = new Map<string, string>()
  const order = [...Object.keys(st.regions)].sort((a, b) => regionReadRank(a) - regionReadRank(b))
  for (const region of order) {
    for (const leaf of leavesOf(st.regions[region])) {
      for (const tab of leaf.tabs) {
        for (const part of flattenContent(tab)) {
          if (!places.has(refId(part))) places.set(refId(part), region)
        }
      }
    }
  }
  for (const entry of st.hidden) {
    const id = refId(entry.ref)
    if (!places.has(id)) places.set(id, entry.returnTo.region)
  }
  return places
}

function newShellId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  // jsdom / 老 WebView 没有 `randomUUID`。坐标只要在这台 core 上唯一即可。
  return `shell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class ShellResourceHost {
  /** 这次运行的坐标。见文件头「不跨重连复用」。 */
  readonly shellId = newShellId()

  /** `client.api(resourcesRouter)` —— 泛型取用,壳里没有按域的客户端文件。 */
  private resources: RouteAPI<ResourcesRoutes> | undefined

  private stopping = false
  private started = false
  private readonly teardown: Array<() => void> = []
  private heartbeat: ReturnType<typeof setInterval> | undefined
  /** 已经跑过的 `callId`,插入序。见 `HANDLED_CALLS_CAP`。 */
  private readonly handled = new Set<string>()
  /** 上一拍这台拼贴台摆着什么。`opened` / `closed` 是它与此刻那一份的差。 */
  private places = new Map<string, string>()
  private diffScheduled = false

  /**
   * 交自述、开续命、订命令、发第一轮 `opened`。**幂等**:第二次调用什么都不做。
   *
   * 顺序是有讲究的:先 `mountShell`(登记不成就一件事都不该做),再订命令
   * (登记之后 core 才可能发命令给这个 id),最后发第一轮 `opened` —— 壳连上时
   * 已经开着的那些也是「打开中」(§10.3),不补这一轮的话,一台重启后的 core
   * 眼里这扇壳空空如也。
   */
  async start(client: OnethingClient): Promise<void> {
    if (this.started || this.stopping) return
    this.started = true
    this.resources = client.api(resourcesRouter)

    const answer = await this.mount()
    if (!answer) return

    /*
     * ── 为什么是 `onAny` 而不是 `on('resource:shell-command')` ────────────────
     * `EventHub.on` 的键收窄在 `TransportEvents` 那三条上(`@onething/client`),
     * 而 `resource:shell-command` 是一条**全局事件**,不在那张表里。给那张表加一行
     * 要改 `packages/client` —— 本单不动那个包(它的头注释写着「加一条推送 =
     * `@shared` 加一条 + 这张表加一行」,那是它自己的一次改动,不是这一单顺手带的)。
     * `onAny` 正是为这一档留的口:「含表里没登记的名字」是它自己的判词。
     */
    this.own(
      client.events.onAny((event) => {
        if (event.name !== 'resource:shell-command') return
        const command = asCommand(event.data)
        // **别扇壳的当没看见** —— SSE 是广播,这一句是这条通道唯一的归属判定。
        if (!command || command.shellId !== this.shellId) return
        this.schedule(command)
      }),
    )

    // 树变了就对一次差。zustand 的 `subscribe` 每次 `set` 都叫,所以真正的活
    // (算两张表的差)排在微任务里合批,见 `scheduleDiff`。
    this.places = openPlaces()
    this.own(useWorkbenchStore.subscribe(() => this.scheduleDiff()))
    for (const [id, region] of this.places) void this.emitFact('opened', id, region)

    // 关窗:**尽力**说一声再见。这一条不保证送达(卸载期的请求可能来不及发出去),
    // 保证由后端那条心跳兜底(90s 没续命即注销)—— 所以这里不做重试,也不 await。
    if (typeof window !== 'undefined') {
      const bye = (): void => {
        void this.resources?.unmountShell({ shellId: this.shellId }).catch(() => {})
      }
      window.addEventListener('beforeunload', bye)
      this.own(() => window.removeEventListener('beforeunload', bye))
    }

    this.heartbeat = setInterval(() => {
      void this.mount()
    }, SHELL_HEARTBEAT_MS)
    log.info('shell resources mounted', this.shellId)
  }

  /** 注销、退订、停表。幂等;`stop()` 之后再来的命令一条都不跑。 */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const undo of this.teardown.splice(0)) {
      try {
        undo()
      } catch {
        // 一条退订炸了不该拦住后面那些 —— 同 `backend.dispose()` 那条纪律。
      }
    }
    void this.resources?.unmountShell({ shellId: this.shellId }).catch(() => {})
  }

  private own(undo: () => void): void {
    if (this.stopping) {
      undo()
      return
    }
    this.teardown.push(undo)
  }

  /**
   * 交一次自述。**幂等续命走的是同一句**(后端按自述的字面判「变没变」,没变就
   * 只盖一个时刻)—— 所以这里不必分「第一次」与「续命」两条路。
   *
   * 登记被拒(`scheme-taken`:另一扇壳先到,或者 core 自己就有一份同名自述)
   * **不重试**:那不是一次网络抖动,重试一百次答案还是同一个。记一条 warn,
   * 这扇壳这一程就没有 `workbench` 这个命名空间 —— 别的一切照常。
   */
  private async mount(): Promise<boolean> {
    if (this.stopping || !this.resources) return false
    try {
      const answer = await this.resources.mountShell({
        shellId: this.shellId,
        spec: workbenchResourceSpec(),
      })
      if (answer.ok) return true
      log.warn('shell resources were refused', answer.reason)
      return false
    } catch (error) {
      log.warn('mounting shell resources failed', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /**
   * 排一条命令。**微任务 + 按 `callId` 幂等**(与 `sweepDeadSessions` 同一条纪律):
   * 事件是在传输的回调里到的,而这一下会去改 store —— 排进微任务让它落在那一拍
   * 的反应之后,读到的树与屏幕上的是同一个。
   */
  private schedule(command: ShellCommandFrame): void {
    if (this.handled.has(command.callId)) return
    this.handled.add(command.callId)
    if (this.handled.size > HANDLED_CALLS_CAP) {
      const oldest = this.handled.values().next()
      if (!oldest.done) this.handled.delete(oldest.value)
    }
    queueMicrotask(() => {
      void this.run(command)
    })
  }

  private async run(command: ShellCommandFrame): Promise<void> {
    if (this.stopping) return
    let result: ShellCommandResult
    try {
      const path = pathOf(command.ref)
      if (command.kind === 'read') {
        // 读法的答案 `JSON.stringify` 进那一格文本 —— 回执契约只有一格文本,
        // 后端那边 `parseShellPayload` 解回来。
        result = { kind: 'ok', text: JSON.stringify(readWorkbench(command.op, path, command.params)) }
      } else {
        result = { kind: 'ok', text: await runWorkbenchOp(command.op, path, command.params) }
      }
    } catch (error) {
      // **只有两支**:授权、取消、参数校验都在 core 里发生完了(§5),壳能说的
      // 只有「跑了,结果是这个」或者「没跑成,因为这个」。
      result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
    try {
      await this.resources?.shellResult({ shellId: this.shellId, callId: command.callId, result })
    } catch (error) {
      // 回执发不出去 = core 那边会超时收场(`ResourceHomeUnavailableError`)。
      // 这里没有第二件事可做 —— 重发一条已经收场的回执只会被 `settle` 判成对不上账。
      log.warn('sending a shell result failed', error instanceof Error ? error.message : String(error))
    }
  }

  /** 一拍里改几十次树只对一次差。合批的判据与 `sweepDeadSessions` 逐字相同。 */
  private scheduleDiff(): void {
    if (this.diffScheduled || this.stopping) return
    this.diffScheduled = true
    queueMicrotask(() => {
      this.diffScheduled = false
      if (this.stopping) return
      this.diff()
    })
  }

  private diff(): void {
    const next = openPlaces()
    const previous = this.places
    this.places = next
    for (const [id, region] of next) {
      if (!previous.has(id)) void this.emitFact('opened', id, region)
    }
    for (const [id, region] of previous) {
      if (!next.has(id)) void this.emitFact('closed', id, region)
    }
  }

  /**
   * 报一条事实。**地址是这扇壳自己的命名空间**(`workbench:<区域>`)——
   * 后端只放行归这扇壳的 scheme,而「那格内容是谁」在载荷里。两者不能对调:
   * 一条 `ref: 'session:x'` 的事实等于这扇壳替 `session:` 说话。
   */
  private async emitFact(event: 'opened' | 'closed', id: string, region: string): Promise<void> {
    if (this.stopping || !this.resources) return
    try {
      await this.resources.emit({
        shellId: this.shellId,
        ref: `${WORKBENCH_SCHEME}:${region}`,
        event,
        payload: { ref: id },
      })
    } catch (error) {
      // 一条报不出去的事实不该拦住屏幕上的任何一件事(它是**转发**,不是真身)。
      log.warn('emitting a workbench fact failed', event, error instanceof Error ? error.message : String(error))
    }
  }
}

/* ── 挂载点(与 content/session-projection.ts 逐字同一个体例)─────────────── */

let host: ShellResourceHost | undefined

/**
 * 起这扇壳的资源提供者。**幂等**;`main.tsx` 在连通之后调一次。
 *
 * 它不 `await` 客户端而是把连通这一段推到后面:壳的启动不该被一次登记往返挡住
 * (登记失败时这台壳照常用,只是 core 那边没有 `workbench` 这个命名空间)。
 */
export function startShellResources(): void {
  if (host) return
  const created = new ShellResourceHost()
  host = created
  void import('../platform/connection')
    .then(({ onethingClient }) => onethingClient())
    .then((client) => {
      // 起到一半被 `stopShellResources()` 掐掉时不要再登记 —— 那会留下一扇
      // 谁也不会替它注销的壳,只能等心跳过期。
      if (host !== created) return
      return created.start(client)
    })
    .catch((error) => {
      log.warn('starting shell resources failed', error instanceof Error ? error.message : String(error))
    })
}

/** 停掉它。幂等。 */
export function stopShellResources(): void {
  host?.stop()
  host = undefined
}

/** 只给测试与门:这一程的坐标。 */
export function shellResourceId(): string | undefined {
  return host?.shellId
}

/*
 * 模块级单例 = 这个模块实例的寿命(09-01 立法)。退役复用已有那一口拆卸,
 * 不写第二套;幂等。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(stopShellResources)
}
