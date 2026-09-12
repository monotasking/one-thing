import { useEffect } from 'react'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'
import { createMutation, createQuery } from './kernel'
import type { Mutation, Rollback } from './kernel'
import { browserPort } from './browser-port'
import type { BrowserResourceEvent } from './browser-port'
import {
  browserDownloadFact,
  browserPermissionRequested,
  browserPermissionResolved,
  forgetBrowserNotices,
  resetBrowserNotices,
  type BrowserDownloadNotice,
  type WebPermissionAsk,
} from './browser-notices'
import { forgetBrowserFind, resetBrowserFind } from './browser-find'

/**
 * 内嵌浏览器的数据层(B2 · 壳半边)。**地址栏上每一颗按钮都走资源路**
 * (`resources.do`),与模型调 `browser` 那只工具是同一条 —— 音乐面板
 * (ca67f35a)立的那条判例在这里逐字适用:真源不在渲染进程里,壳与 AI 就
 * 不该各走各的路。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行 · ① 生命周期(施工纪律第一条;②③ 两张在 `content/browser/
 * BrowserLeaf.tsx` 与 `content/native-view/NativeViewSlot.tsx` 的组件头上)
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  · 挂载    —— import 这只文件只建了一格空 query 与七只 mutation,
 *                **零往返、零订阅**;
 *  · 首载    —— `openBrowserSource()`(第一片浏览器叶挂载时):等传输面 ready →
 *                订上 `resource:event`(前缀 `browser:`)→ `tabs` `ensure()` 一次。
 *                **先订后拉**:拉的那一刻起的 `navigated` 不能漏;
 *  · 事件到达 —— 按 `EVENT_INVALIDATES` 那张表标脏。有人在看就后台补拉、
 *                **不清屏**(律②);没人看就留个脏标记;
 *  · 换宿主  —— 叶从架子拖成浮窗 / 抬上舞台,拼贴树的结构共享保证它不重挂,
 *                所以这条线一格都不动。**视图更不会重载** —— 那正是
 *                `WebContentsView` 相对 `<webview>` 赚回来的那一格(§2.2-1);
 *  · 卸载    —— `closeBrowserSource()`:refcount 归零才退订。**读数留在格子里**;
 *  · HMR     —— `resetBrowserSource()`(复用同一口拆卸,不写第二套)。
 *
 * ── 为什么只有**一格** query,而不是每 tab 一格 ──────────────────────────
 * 自述里 `tabs` 是一条**命名空间级**的读法,交的是整张表 + `activeId`
 * (`electron/browser/resource-spec.ts` 的 `TABS_RESULT`)。每 tab 一格 query 要
 * 么得有一条 per-tab 的读法(没有),要么得让每一格自己从整表里挑一行(那就是
 * 把同一份答案存 N 遍)。一格整表 + 事件标脏,是这份自述给出的形状。
 *
 * ── 为什么 `do` 的非 ok 结局在这里**抛** ───────────────────────────────
 * 与 `music-source.ts` 逐字同一条:`createMutation` 的回滚只挂在 catch 上
 * (「先回滚再报错:屏幕上不许留一张后端没认下的牌」)。一次被拒绝的 `navigate`
 * 如果 resolve,乐观补丁就会永远留在屏幕上说「正在加载」——而页面根本没动。
 * 端口那一层照旧完整地交五支(判词在 `browser-port.ts` 头上),折成一次 throw
 * 是**消费方**的决定,不是传输层把结局吞了。
 */

/* ── 地址 ────────────────────────────────────────────────────────────────── */

export const BROWSER_SCHEME_PREFIX = 'browser:'

/**
 * 「整个浏览器」那一个**保留坐标**。
 *
 * 自述里 `tabs` 读与 `open` 做是命名空间级的(`ref === null`,
 * `electron/browser/resource-provider.ts` 的 `NAMESPACE_MEMBERS`:这两条根本不读
 * ref)。但 **RPC 那一侧的 `ref` 是一个必填串** —— `resources.read/do` 收的是
 * `{ref: string}`,而 `parseRef` 要求 path 非空(`packages/core/resource/ref.ts`)。
 * 「没有地址」这件事 AI 那条路表达得出来,三个出口都表达不出。
 *
 * 所以照 `SESSION_COLLECTION_PATH`(`@all`)那条先例用一个**保留坐标**:一个不可能
 * 与真 tab id 相撞的字面量(tab id 是 UUID v4,`@` 不在它的字符集里)。provider 对
 * 这两条成员不读 ref,于是它到达那一侧只是一个被忽略的路径;它存在只为让地址在
 * 内核的语法上成立。
 */
export const BROWSER_COLLECTION_REF = `${BROWSER_SCHEME_PREFIX}@all`

/** 一格 tab 的地址。 */
export function browserTabRef(tabId: string): string {
  return `${BROWSER_SCHEME_PREFIX}${tabId}`
}

/* ── 读数的形(逐格对着 `electron/browser/resource-spec.ts` 的 TAB_SCHEMA)──── */

/*
 * ui-consume-allow: async-busy-boolean — `loading` 不是壳自己攒的忙布尔,它是
 * **后端那一格 tab 的读数**(`electron/browser/resource-spec.ts` 的 TAB_SCHEMA:
 * Chromium 的 did-start/stop-loading),与「这发请求在飞没在飞」是两件事。逐格
 * pending 那一半照律③走 `createMutation`(下面七只 mutation 各有自己的 pending)。
 */
export interface BrowserTabRow {
  id: string
  url: string
  title: string
  // ui-consume-allow: async-busy-boolean — 见上:它是后端那一格 tab 的读数,不是忙布尔
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  error?: string
  profile: string
}

export interface BrowserTabsView {
  tabs: BrowserTabRow[]
  /** 没有活动 tab 时**缺席**(不是空串)—— 自述那一行写着。 */
  activeId?: string
}

/** 一格 tab 的正文(`page` 读法)。正文已经被 `untrusted-content` 定界包过。 */
export interface BrowserPageView {
  title: string
  url: string
  text: string
}

/* ── 结局 → 一句人话(四支 / 五支,**不发明文案**)────────────────────────── */

function readFailureText(view: ResourceReadView): string {
  switch (view.kind) {
    case 'invalid':
      return view.message
    case 'denied':
      return view.reason
    case 'failed':
      return view.error.message
    default:
      return ''
  }
}

function outcomeFailureText(view: ResourceOutcomeView): string {
  switch (view.kind) {
    case 'invalid':
      return view.message
    case 'denied':
      return view.reason
    case 'aborted':
      return view.reason ?? ''
    case 'failed':
      return view.error.message
    default:
      return ''
  }
}

async function readResource<T>(
  ref: string,
  name: string,
  query?: Record<string, unknown>,
): Promise<T> {
  const port = await browserPort()
  await port.ready()
  const answer = await port.read(ref, name, query)
  if (answer.kind === 'ok') return answer.value as T
  throw new Error(readFailureText(answer))
}

/* ── 一条读数 ────────────────────────────────────────────────────────────── */

/** 开着哪几格、哪一格在前面。**live** —— 靠四条事实推着走,壳不轮询。 */
export const browserTabsQuery = createQuery<BrowserTabsView>('browser.tabs', () =>
  readResource<BrowserTabsView>(BROWSER_COLLECTION_REF, 'tabs'),
)

/** 屏幕上此刻那一格的读数(没有就是 undefined)。 */
export function browserTabOf(tabId: string): BrowserTabRow | undefined {
  return browserTabsQuery.get().data?.tabs.find((row) => row.id === tabId)
}

/* ── 七条做法 ────────────────────────────────────────────────────────────── */

export type BrowserOpName =
  | 'open'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'activate'
  | 'close'
  | 'respondPermission'

export interface BrowserOpInput {
  /** 除 `open` 之外每一条都要它。 */
  tabId?: string
  url?: string
  background?: boolean
  /**
   * `open` 那一条的身份(B3-b)。**缺席就是缺席** —— 回落成哪一格由后端现问
   * 设置(`electron/browser/service.ts` 的 `defaultProfile`),壳这边不替它拍板。
   */
  profile?: string
  /** `respondPermission` 那两格(B3-a)。 */
  requestId?: string
  allow?: boolean
}

interface BrowserOpSpec {
  /** 它打在哪个地址上。`open` 打在保留坐标上,其余打在那一格 tab 上。 */
  ref: (input: BrowserOpInput) => string
  /** 递给后端的那几格(**不含 tabId** —— 那是地址,不是参数)。 */
  params?: (input: BrowserOpInput) => Record<string, unknown>
  /** 按下去屏幕先怎么变(律①)。返回回滚 —— 补丁与撤销出自同一处。 */
  optimistic?: (input: BrowserOpInput) => Rollback | void
}

function tabRefOf(input: BrowserOpInput): string {
  return browserTabRef(input.tabId ?? '')
}

/** 在整张表上打一个补丁。读不到旧值就什么都不做(没有可乐观的对象)。 */
function patchTabs(next: (prev: BrowserTabsView) => BrowserTabsView): Rollback {
  return browserTabsQuery.patch((prev) => (prev ? next(prev) : prev))
}

/** 一格行上打补丁。 */
function patchRow(tabId: string, next: (row: BrowserTabRow) => BrowserTabRow): Rollback {
  return patchTabs((prev) => ({
    ...prev,
    tabs: prev.tabs.map((row) => (row.id === tabId ? next(row) : row)),
  }))
}

/**
 * 「这一下会让它开始转」。
 *
 * 四条导航做法共用:按了后退/前进/刷新/回车,**加载条要当场亮**。等后端那条
 * `loading` 事实绕一圈回来是 20–30ms 起步(B0 ⑦ 的遮挡回路读数同量级),而人
 * 的手感阈值在那之下 —— 律①要的正是这一格。
 */
function optimisticLoading(input: BrowserOpInput): Rollback | void {
  if (!input.tabId) return undefined
  return patchRow(input.tabId, (row) => ({ ...row, loading: true }))
}

/**
 * 做法表。**每一行三格,一个 `if (op === …)` 都没有** —— 加一条做法 = 这张表
 * 加一行(以及地址栏上一颗钮),`runBrowserOp` 与七只 mutation 的装配一个字不动。
 */
const OPS: Readonly<Record<BrowserOpName, BrowserOpSpec>> = {
  /*
   * 开一格。**没有乐观补丁** —— 壳这一侧不知道新那格的 id(`do` 的 ok 结局只
   * 带一句文本),编一行假的进表里,`opened` 事实到了之后会变成两行。
   */
  open: {
    ref: () => BROWSER_COLLECTION_REF,
    params: (input) => ({
      ...(input.url ? { url: input.url } : {}),
      ...(input.background ? { background: true } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
    }),
  },
  navigate: {
    ref: tabRefOf,
    params: (input) => ({ url: input.url ?? '' }),
    // 地址当场换成要去的那一个:人按了回车,地址栏不该弹回旧地址再跳过去。
    optimistic: (input) =>
      input.tabId
        ? patchRow(input.tabId, (row) => ({ ...row, loading: true, url: input.url ?? row.url }))
        : undefined,
  },
  back: { ref: tabRefOf, optimistic: optimisticLoading },
  forward: { ref: tabRefOf, optimistic: optimisticLoading },
  reload: { ref: tabRefOf, optimistic: optimisticLoading },
  activate: {
    ref: tabRefOf,
    optimistic: (input) =>
      input.tabId
        ? patchTabs((prev) => ({
            ...prev,
            activeId: input.tabId,
            tabs: prev.tabs.map((row) => ({ ...row, active: row.id === input.tabId })),
          }))
        : undefined,
    },
  close: {
    ref: tabRefOf,
    // 关掉的那一行当场从表里走 —— 它背后那片叶由拼贴树自己收拾(kind.dispose)。
    optimistic: (input) =>
      input.tabId
        ? patchTabs((prev) => ({ ...prev, tabs: prev.tabs.filter((row) => row.id !== input.tabId) }))
        : undefined,
  },
  /*
   * 答一次网页权限询问(B3-a)。
   *
   * **没有乐观补丁**,而这是一次有意的例外:那张卡收不收由后端那条
   * `permissionResolved` 说了算(答了 / 超时 / tab 没了三条收场共用它)。壳这一侧
   * 当场把卡撤掉,会让「另一扇窗刚好答掉了」与「我这一发被拒了」两种现场长得一样,
   * 而且撤早了之后这一发万一失败,屏幕上就再也没有那一问了 —— 那头页面还在等。
   * 一发往返是 20–30ms,而这一格不是「按下去要有手感」的那一类:人刚刚按的是
   * 一颗**有后果**的键,让它等后端认下来那一下是对的。
   */
  respondPermission: {
    ref: tabRefOf,
    params: (input) => ({ requestId: input.requestId ?? '', allow: input.allow === true }),
  },
}

/** 发一条命令。**七条共用这一句** —— 非 ok 一律抛,理由在文件头。 */
async function runBrowserOp(op: BrowserOpName, input: BrowserOpInput): Promise<void> {
  const spec = OPS[op]
  const port = await browserPort()
  const outcome = await port.do(spec.ref(input), op, spec.params?.(input) ?? {})
  if (outcome.kind === 'ok') return
  throw new Error(outcomeFailureText(outcome))
}

function createBrowserOp(op: BrowserOpName): Mutation<BrowserOpInput, void> {
  const spec = OPS[op]
  return createMutation<BrowserOpInput, void>(`browser.${op}`, {
    run: (input) => runBrowserOp(op, input),
    key: (input) => input.tabId ?? '',
    optimistic: (input) => spec.optimistic?.(input),
    /*
     * 对账**一条**:整张表。七条做法改的都是这张表上的格子,后端那四条事实也
     * 都落在它上面 —— 一格读数没有第二个对账对象。
     */
    settle: () => {
      browserTabsQuery.invalidate()
    },
  })
}

const OP_NAMES = Object.keys(OPS) as BrowserOpName[]

/**
 * **一只做法一只 mutation**。每一只有自己的 `pending` 与自己的 `error`,
 * 于是「按了刷新,刷新那颗钮转、后退照常能点」是形状而不是自觉(律③逐格 pending)。
 * `key` 取 tabId —— 两格 tab 各自转各自的。
 */
export const browserOps = Object.fromEntries(
  OP_NAMES.map((op) => [op, createBrowserOp(op)]),
) as Readonly<Record<BrowserOpName, Mutation<BrowserOpInput, void>>>

/**
 * 开一格并**答出它的 id**。
 *
 * `do` 的 ok 结局只带一句给人看的文本(`ResourceOutcomeView`),里面那串 id 是
 * 写给人读的不是给人解析的。所以这里的判据是**表的前后差**:开之前记下有哪几格,
 * 开完重问一次,新冒出来的那一格就是它。这条路对并发也是对的(两发同时开,
 * 各自看见各自那一格),而解析文本不是。
 *
 * 开不出来(后端拒绝 / 这台宿主没有浏览器)答 `null` —— 调用方据它决定摆不摆叶。
 */
export async function openBrowserTab(
  init: { url?: string; background?: boolean; profile?: string } = {},
): Promise<string | null> {
  const before = new Set((browserTabsQuery.get().data?.tabs ?? []).map((row) => row.id))
  await browserOps.open.run({ ...init })
  await browserTabsQuery.refetch()
  const table = browserTabsQuery.get().data
  const fresh = table?.tabs.find((row) => !before.has(row.id))
  return fresh?.id ?? null
}

/**
 * 读一格的正文。**不进 query** —— 它是一次性的取件(AI 那条路走
 * `resources.read(browser:<id>, 'page')`,与这一句同一个地址同一条路),不是屏幕上
 * 要一直新鲜的读数。
 *
 * 今天壳里没有消费者(@ 引入那条路排在 B3)。留着它是因为「壳能读到它自己那一格
 * 的正文」是这条线的一部分,而且它是**这一侧**唯一会用 `page` 那条读法的地方 ——
 * 单测拿它钉住地址与 `maxChars` 怎么递(改错了那一条当场红)。
 */
export function readBrowserPage(tabId: string, maxChars?: number): Promise<BrowserPageView> {
  return readResource<BrowserPageView>(
    browserTabRef(tabId),
    'page',
    maxChars !== undefined ? { maxChars } : undefined,
  )
}

/* ── 事实到了,重问哪一条 ───────────────────────────────────────────────── */

/**
 * `resource:event` → 标脏哪几格。**表,不是 switch**:后端将来多发一种事实,
 * 这里加一行;不在表上的事实**当没看见**。
 */
const EVENT_INVALIDATES: Readonly<Record<string, readonly { invalidate(): void }[]>> = {
  opened: [browserTabsQuery],
  closed: [browserTabsQuery],
  navigated: [browserTabsQuery],
  loading: [browserTabsQuery],
}

/**
 * 事实 → **不是读数**的那一半(B3-a)。
 *
 * 权限询问与下载都不是「屏幕上要一直新鲜的读数」,它们是**一件件到达的事**:
 * 一问来了、那一问结了、一次下载落地了。标脏一条 query 表达不了它们(重拉整张
 * tab 表既答不出「谁在问」,也会把一次超时抹成没发生过)。所以第二张表:
 * 事实 → 交给谁记。**表,不是 switch**;不在表上的事实当没看见。
 *
 * `closed` 在两张表上各有一行,而那不是重复:一张说「tab 表脏了」,另一张说
 * 「这一格身上那些临时的东西该扔了」—— 两件事,两个消费者。
 */
const EVENT_NOTICES: Readonly<Record<string, (payload: unknown) => void>> = {
  'permissionRequested': (payload) => {
    const row = payload as WebPermissionAsk
    if (typeof row?.tabId === 'string' && typeof row?.requestId === 'string') {
      browserPermissionRequested({
        tabId: row.tabId,
        requestId: row.requestId,
        permission: String(row.permission ?? ''),
        origin: String(row.origin ?? ''),
      })
    }
  },
  'permissionResolved': (payload) => {
    const row = payload as { tabId?: unknown; requestId?: unknown }
    if (typeof row?.tabId === 'string' && typeof row?.requestId === 'string') {
      browserPermissionResolved({ tabId: row.tabId, requestId: row.requestId })
    }
  },
  download: (payload) => {
    const row = payload as BrowserDownloadNotice
    if (typeof row?.tabId === 'string' && typeof row?.path === 'string') {
      browserDownloadFact({
        tabId: row.tabId,
        filename: String(row.filename ?? ''),
        state: row.state === 'done' || row.state === 'failed' ? row.state : 'started',
        path: row.path,
      })
    }
  },
  closed: (payload) => {
    const id = (payload as { id?: unknown })?.id
    if (typeof id !== 'string') return
    forgetBrowserNotices(id)
    forgetBrowserFind(id)
  },
}

export function onBrowserFact(fact: BrowserResourceEvent): void {
  for (const query of EVENT_INVALIDATES[fact.event] ?? []) query.invalidate()
  EVENT_NOTICES[fact.event]?.(fact.payload)
}

/* ── 这条线的开与关 ──────────────────────────────────────────────────────── */

let openCount = 0
let unsubscribe: (() => void) | undefined

export async function openBrowserSource(): Promise<void> {
  openCount += 1
  if (openCount > 1) return
  const port = await browserPort()
  await port.ready()
  // 等 ready 的这一段里叶又被关掉了:这一发作废。
  if (openCount === 0) return
  unsubscribe?.()
  unsubscribe = port.onResourceEvent(BROWSER_SCHEME_PREFIX, onBrowserFact)
  // 先订后拉(见文件头)。
  await browserTabsQuery.ensure()
}

export function closeBrowserSource(): void {
  if (openCount > 0) openCount -= 1
  if (openCount > 0) return
  unsubscribe?.()
  unsubscribe = undefined
}

/** 回到出厂:退订 + 读数归零 + 七只 mutation 归零。测试与 HMR 用。 */
export function resetBrowserSource(): void {
  openCount = 0
  unsubscribe?.()
  unsubscribe = undefined
  browserTabsQuery.reset()
  for (const op of OP_NAMES) browserOps[op].reset()
  // 这条线上还挂着两格**不是读数**的东西(B3-a)。归零一次就该把它们一起归零 ——
  // 两套拆卸迟早漏一格。
  resetBrowserNotices()
  resetBrowserFind()
}

/**
 * 屏幕上有浏览器叶挂着的那一段,就是这条线活着的那一段。**唯一的挂载点**
 * —— 组件里不再写第二段 effect(两处订阅迟早漏一格)。
 */
export function useBrowserLive(): void {
  useEffect(() => {
    void openBrowserSource()
    return () => closeBrowserSource()
  }, [])
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法)。退役**复用已有的那一口拆卸**,
 * 不写第二套;它自身幂等。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetBrowserSource)
}
