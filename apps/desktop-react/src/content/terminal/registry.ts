import { invalidateTerminalList } from '../../data/terminal-source'
import { terminalPort } from '../../data/terminal-port'
import { onThemeApplied } from '../../theme/theme-source'
import { TerminalSession } from './session'
import { forgetTerminalCwd, rememberTerminalCwd } from './terminal-memory'
import type { TerminalScreen } from './screen'

/**
 * **活着的那几格终端**(T1,方案 §2.1-4)。
 *
 * ── 为什么是模块级的一张 Map,而不是组件里的 state ───────────────────────
 * 旧壳 D6 判例:一格终端的寿命是**那格 PTY**,不是「哪个组件此刻挂着它」。
 * 把 xterm 实例放进组件 state,拖一格 tab 到别的叶就会重挂 —— 屏幕、滚动位置、
 * 选区、正在跑的 `top` 全没了。所以实例住在这里,组件挂载只
 * `appendChild(session.element)`,卸载**什么都不做**。
 *
 * 真正丢一格的口只有一个:`closeTerminal(id)`(关标签 = 杀,方案 §2.1-8)。
 *
 * ── 主题订阅为什么在这一层 ──────────────────────────────────────────────
 * 「主题换了」是**一件事**,而屏幕有好几块。订阅一条、遍历所有实例,比让每块
 * 屏幕各订一条省一堆重复退订(而那正是漏一格的来源)。`TerminalSession` 因此
 * 是纯的:它只认识 `refreshFace()` 这一口,不认识主题管道。
 *
 * ── HMR ────────────────────────────────────────────────────────────────
 * 这只文件的模块级副作用有两样:那张 Map 与那条主题订阅。退役复用同一口拆卸
 * (`resetTerminalRegistry`),它自身幂等。**热更会真的销毁屏幕** —— 改这只
 * 文件时开着的终端会重画一次(PTY 不死,重挂之后 `attach` 把回放拿回来)。
 */

const REGISTRY = new Map<string, TerminalSession>()

/**
 * **屏幕工厂是注入的,而且这只文件不认识 xterm**(一格闩,体例同
 * `registerContentKind`)。
 *
 * 两个理由,第二个是真正的那个:
 *  ① 测试要换一块记事本屏幕(jsdom 里量不出字形);
 *  ② **`@xterm/xterm` 在 import 的那一刻就去 `canvas.getContext`**(它的
 *     `Color.ts` 在模块作用域里探一次颜色支持)。这只文件被 `kinds/terminal.tsx`
 *     静态 import,而那张种类表被 `main.tsx` 与一大票测试 import —— 静态挂着
 *     xterm 等于让每一个渲染类测试都把它整只加载一遍、并在 jsdom 里各喊一声
 *     "Not implemented: HTMLCanvasElement.prototype.getContext"。
 *
 * 所以真实现由 `./screen.ts` **自己登记**(那只文件在模块末尾调这一口),而
 * 拉起它的是 `TerminalLeaf`(渲染一格终端的那条路,也是唯一真需要屏幕的路)。
 * 产品侧因此顺手多得一件:xterm 进了自己的 chunk,不开终端就不下载。
 */
let makeScreen: (() => TerminalScreen) | undefined

/** 登记屏幕实现(`./screen.ts` 与测试各调一次)。传 undefined 摘掉。 */
export function configureTerminalScreenFactory(next: (() => TerminalScreen) | undefined): void {
  makeScreen = next
}

/**
 * **「这一格是刚被人亲手开出来的」那张点名条**(T1)。
 *
 * ── 为什么需要它(真机量出来的,不是理论)────────────────────────────────
 * 响应链规则 2 是「打开什么,焦点进什么」。启动瓦这条路上送不进去:离屏壳 +
 * `window.__focus.dump()` 量到的形是 —— `placeRef` 之后那一拍,树上已经有了
 * **叶那一层**(`leaf@… owner=terminal:<id>`),却还没有内容自己那一格
 * (`terminal@…`)。于是 `focusIntoRef` 的第一问答 false、退回叶,焦点停在那
 * 一层的根上:终端开出来了,打字进不去。
 *
 * 修法**不是**在外面数帧重试(那是拿时间窗口赌一个次序,而且用户在这一拍里
 * 点了别处就会被拽回来)。这里用的是这台壳自己的判例:`stage/summon.ts` 的
 * `requestFocusOnOpen` / `takeOpenRequest` —— **开的人点名,被开的那一格挂载时
 * 自己取走**。挂载一定排在点名之后,所以它没有窗口可言。
 *
 * 一次性:取过就没了(`take`)。所以「布局恢复时冒出来的终端」不会抢焦点 ——
 * 没人点过它的名。
 */
const FOCUS_REQUESTS = new Set<string>()

/** 点名:这一格是我刚开出来的,它挂载时该拿到键盘。 */
export function requestTerminalFocus(id: string): void {
  FOCUS_REQUESTS.add(id)
}

/** 取走那张条(一次性)。没被点过名就是 false。 */
export function takeTerminalFocusRequest(id: string): boolean {
  return FOCUS_REQUESTS.delete(id)
}

let offTheme: (() => void) | undefined

/** 第一格终端出现时才订主题 —— 没有终端的那台壳一条订阅都不该挂。 */
function ensureThemeSubscription(): void {
  offTheme ??= onThemeApplied(() => {
    for (const session of REGISTRY.values()) session.refreshFace()
  })
}

/**
 * 拿这一格的实例;没有就**造一个并 attach**。
 *
 * `initialTitle` 是建的那一刻就知道的名字(cwd 末段),attach 回来会盖掉它 ——
 * 有它是为了让标签在第一帧就写得出字,而不是先画一个 id。
 */
export function terminalSessionOf(id: string, initialTitle = ''): TerminalSession {
  const now = REGISTRY.get(id)
  if (now) return now
  if (!makeScreen) throw new Error('terminal screen 还没登记 —— import content/terminal/screen')
  ensureThemeSubscription()
  const session = new TerminalSession(id, { port: lazyPort(), screen: makeScreen() }, initialTitle)
  REGISTRY.set(id, session)
  void session.attach()
  return session
}

/** 屏幕上有没有这一格(不造)。 */
export function peekTerminalSession(id: string): TerminalSession | undefined {
  return REGISTRY.get(id)
}

/**
 * **关标签 = 杀**(方案 §2.1-8,不弹确认)。
 *
 * 次序:先杀 PTY,再拆这一侧,再把小账本上那一笔忘掉。`dead` 那一档杀不着
 * (那格 PTY 早就不在了)—— `kill` 自己吞掉那次失败,所以这里不分档。
 */
export function closeTerminal(id: string): void {
  const session = REGISTRY.get(id)
  REGISTRY.delete(id)
  if (session) {
    void session.kill()
    session.dispose()
  }
  forgetTerminalCwd(id)
  invalidateTerminalList()
}

/**
 * 开一格新的。交回终端 id;开不出来就抛(调用方就地一行说出后端那句话)。
 *
 * 建的那一刻记一笔 `id → cwd`(判词在 `terminal-memory.ts`:只在建的时候记)。
 */
export async function createTerminal(options: { cwd?: string; sessionId?: string } = {}): Promise<string> {
  const port = await terminalPort()
  await port.ready()
  const answer = await port.create(options)
  if (!answer.success || !answer.terminal) throw new Error(answer.error || 'terminal.create 未成功')
  rememberTerminalCwd(answer.terminal.id, answer.terminal.cwd)
  invalidateTerminalList()
  return answer.terminal.id
}

/**
 * 端口那一口。`TerminalSession` 收的是一个**已经在手里**的端口(它的构造函数
 * 不许是 async —— 那会让「一格实例」变成「一个 Promise」),而真端口是惰性建的。
 * 这里因此交一份**转发壳**:每一口都在调用那一刻才去取真的那一份。
 */
function lazyPort(): import('../../data/terminal-port').TerminalPort {
  const of = () => terminalPort()
  return {
    ready: () => of().then((p) => p.ready()),
    create: (request) => of().then((p) => p.create(request)),
    list: () => of().then((p) => p.list()),
    write: (id, data) => of().then((p) => p.write(id, data)),
    resize: (id, cols, rows) => of().then((p) => p.resize(id, cols, rows)),
    kill: (id) => of().then((p) => p.kill(id)),
    attach: (id) => of().then((p) => p.attach(id)),
    ack: (id, bytes, generation) => of().then((p) => p.ack(id, bytes, generation)),
    /*
     * 两条推送是**同步返回退订**的口,而真端口要 await 才拿得到。所以这里先
     * 交一个占位退订,真订上之后如果已经被退过就当场退掉 —— 一格实例在
     * 「建出来到端口就绪」之间被 dispose 掉时,订阅不许漏在外面。
     */
    onData: (cb) => forward((p) => p.onData(cb)),
    onExit: (cb) => forward((p) => p.onExit(cb)),
  }
}

function forward(subscribe: (port: import('../../data/terminal-port').TerminalPort) => () => void): () => void {
  let off: (() => void) | undefined
  let cancelled = false
  void terminalPort().then((port) => {
    if (cancelled) return
    off = subscribe(port)
  })
  return () => {
    cancelled = true
    off?.()
    off = undefined
  }
}

/** 回到出厂:销毁每一块屏幕、退主题订阅。**不杀 PTY**(热更不该让 shell 死掉)。 */
export function resetTerminalRegistry(): void {
  for (const session of REGISTRY.values()) session.dispose()
  REGISTRY.clear()
  FOCUS_REQUESTS.clear()
  offTheme?.()
  offTheme = undefined
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetTerminalRegistry)
}
