/**
 * `onething://` 深链协议(H4)—— 应用之外的世界敲门的**唯一一扇门**。
 *
 * 这个文件只放**语法与门规**,零 import、零副作用:URL 怎么念、什么形状合法、
 * 哪些拒绝要让用户看见、插件动作的声明门叫什么、handler 的预算是多少。投递、
 * 确认卡、协议注册全在宿主(Electron)与装配层 —— core 不认识窗口。
 *
 * 四条纪律,每一条都是拿"外部世界可以随便构造这个字符串"当前提写的:
 *
 *  1. **text 是数据,不是指令**。`ask` 确认后它按**普通用户消息**入会话,插件
 *     动作确认后它以 `{ text, params }` 交给 handler。宿主任何一处都不解释它的
 *     内容 —— 一个从剪贴板来的字符串不该因为长得像命令就变成命令。
 *  2. **每一次都要确认**。v1 没有信任名单、没有免确认档(append-only 留位)。
 *     一条深链能做的最坏的事,上限是"用户看着全文按了确认"。
 *  3. **拒绝分两种,且分得死**:形状非法 / 未知动词 = **静默丢弃 + 一行日志**
 *     (弹窗本身就是骚扰面 —— 外部随便构造一串就能让用户被弹一次,那扇门必须
 *     是哑的);内容过长 = **看得见的拒绝**(用户刚按下的那个按钮得到一句回话,
 *     否则他只会以为应用坏了)。判据在 `DEEPLINK_VISIBLE_REJECTIONS`,不是撒在
 *     调用点上。
 *  4. **动词是枚举,不是字符串**。v1 只开 `ask` 一个宿主动词;插件动作走
 *     `x/<pluginId>/<action>` 这条**不与宿主动词共享命名空间**的支路 ——
 *     插件永远抢不到一个宿主动词名,新增宿主动词也永远不会顶掉某个插件。
 */

/* ── 协议语法 ──────────────────────────────────────────────────────────── */

/** scheme。`app.setAsDefaultProtocolClient` 注册的就是它。 */
export const ONETHING_DEEPLINK_SCHEME = 'onething'

/**
 * 宿主动词表。**append-only**:加一个动词 = 这里加一行 + 解析里给它一个形状 +
 * 确认卡里给它一句人话。v1 只有 `ask`。
 */
export const DEEPLINK_HOST_VERBS = ['ask'] as const

export type DeepLinkHostVerb = (typeof DEEPLINK_HOST_VERBS)[number]

/**
 * 插件动作的支路前缀:`onething://x/<pluginId>/<action>`。
 *
 * 用一个宿主动词名当不了的短前缀,是为了让"宿主动词"与"插件动作"两个命名空间
 * **物理分开**:插件抢不到 `ask`,将来加 `open` / `run` 也不会顶掉谁。
 */
export const DEEPLINK_PLUGIN_PREFIX = 'x'

/**
 * `text` 的长度上限(UTF-8 字节)。
 *
 * 32KB 是"一篇长文选中之后整段发过来"的量级,再往上就不是深链该干的事了
 * (那是附件)。超限**不是静默丢弃** —— 见文件头第 3 条。
 */
export const DEEPLINK_TEXT_MAX_BYTES = 32 * 1024

/** 插件 id 的形状(与 npm 包名的可用子集一致,不含斜杠 —— 路径要分得开)。 */
export const DEEPLINK_PLUGIN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** 动作名的形状。刻意窄:小写字母、数字、连字符。 */
export const PLUGIN_DEEPLINK_ACTION_NAME_PATTERN = /^[a-z0-9-]+$/

/* ── 解析结果 ──────────────────────────────────────────────────────────── */

/** `onething://ask?text=…&agent=…` */
export interface DeepLinkAskIntent {
  kind: 'ask'
  /** 用户要问的话。原样,不做任何解释。 */
  text: string
  /** 可选的 agent 档案 id。查不到时由宿主回落默认**并在确认卡上说明**。 */
  agentId?: string
}

/** `onething://x/<pluginId>/<action>?text=…&<其余参数原样透传>` */
export interface DeepLinkPluginIntent {
  kind: 'plugin'
  pluginId: string
  action: string
  /** 可缺省(空串)—— 有些动作只要参数。 */
  text: string
  /** 除 `text` 之外的全部查询参数,原样透传给 handler。重复键取最后一个。 */
  params: Record<string, string>
}

export type DeepLinkIntent = DeepLinkAskIntent | DeepLinkPluginIntent

/**
 * 拒绝的理由。
 *
 * `text-too-long` 之外的每一种都意味着"这串东西根本不是一条我们认识的深链",
 * 对它们弹窗等于把弹窗权交给任何一个能构造 URL 的人。
 */
export type DeepLinkRejectReason =
  | 'not-a-string'
  | 'wrong-scheme'
  | 'malformed-url'
  | 'unknown-verb'
  | 'missing-text'
  | 'bad-plugin-id'
  | 'bad-action-name'
  | 'text-too-long'

/**
 * **看得见的**拒绝 —— 只有这一种会走到确认卡上(卡上是一句"内容过长已拒",
 * 没有确认按钮)。其余一律静默丢弃 + 一行日志。
 *
 * 收在这里而不是写在宿主的 if 里,是因为这条判据一旦撒出去就会漂:某一处顺手
 * 多弹一种,那扇门就从哑的变成了骚扰面。
 */
export const DEEPLINK_VISIBLE_REJECTIONS: readonly DeepLinkRejectReason[] = ['text-too-long']

export function isVisibleDeepLinkRejection(reason: DeepLinkRejectReason): boolean {
  return DEEPLINK_VISIBLE_REJECTIONS.includes(reason)
}

export type DeepLinkParseResult =
  | { ok: true, intent: DeepLinkIntent }
  | { ok: false, reason: DeepLinkRejectReason, detail: string }

function reject(reason: DeepLinkRejectReason, detail: string): DeepLinkParseResult {
  return { ok: false, reason, detail }
}

/** UTF-8 字节数。`TextEncoder` 在 node 与浏览器都是全局的(core 不引第三方)。 */
export function deepLinkTextByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * 严格解析一条 `onething://` URL。
 *
 * **严格**的意思是:多一节路径、少一个必需参数、动词不认识 —— 全部拒绝,没有
 * "尽力猜一下"。猜错的代价是往用户的会话里投一条他没要的东西。
 */
export function parseDeepLink(raw: unknown): DeepLinkParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return reject('not-a-string', 'deep link must be a non-empty string')
  }
  const input = raw.trim()

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return reject('malformed-url', `not a parsable URL: ${input.slice(0, 120)}`)
  }
  if (url.protocol !== `${ONETHING_DEEPLINK_SCHEME}:`) {
    return reject('wrong-scheme', `expected ${ONETHING_DEEPLINK_SCHEME}://, got ${url.protocol}`)
  }

  // `onething://ask?…` 里 host = 'ask';`onething://x/a/b` 里 host = 'x'。
  // 大小写:URL 会把 host 规范化成小写,动词表也是小写,天然一致。
  const head = url.host
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponentSafe)

  const text = url.searchParams.get('text') ?? ''
  if (deepLinkTextByteLength(text) > DEEPLINK_TEXT_MAX_BYTES) {
    return reject(
      'text-too-long',
      `text is ${deepLinkTextByteLength(text)} bytes, limit is ${DEEPLINK_TEXT_MAX_BYTES}`,
    )
  }

  if (head === DEEPLINK_PLUGIN_PREFIX) {
    if (segments.length !== 2) {
      return reject('unknown-verb', `plugin deep link needs exactly <pluginId>/<action>, got ${segments.length} segment(s)`)
    }
    const [pluginId, action] = segments
    if (!DEEPLINK_PLUGIN_ID_PATTERN.test(pluginId)) {
      return reject('bad-plugin-id', `illegal plugin id: ${pluginId.slice(0, 80)}`)
    }
    if (!PLUGIN_DEEPLINK_ACTION_NAME_PATTERN.test(action)) {
      return reject('bad-action-name', `illegal action name: ${action.slice(0, 80)}`)
    }
    const params: Record<string, string> = {}
    for (const [key, value] of url.searchParams.entries()) {
      if (key === 'text') continue
      params[key] = value
    }
    return { ok: true, intent: { kind: 'plugin', pluginId, action, text, params } }
  }

  if (!(DEEPLINK_HOST_VERBS as readonly string[]).includes(head)) {
    return reject('unknown-verb', `unknown verb: ${head.slice(0, 80)}`)
  }
  // 宿主动词不吃路径段 —— `onething://ask/anything` 是形状非法,不是"忽略后面"。
  if (segments.length > 0) {
    return reject('unknown-verb', `host verb "${head}" takes no path segments`)
  }

  // 只有 ask 这一个动词(DEEPLINK_HOST_VERBS 的穷举点)。
  if (!text) return reject('missing-text', 'ask requires a non-empty text parameter')
  const agentId = url.searchParams.get('agent')?.trim()
  const intent: DeepLinkAskIntent = { kind: 'ask', text }
  if (agentId) intent.agentId = agentId
  return { ok: true, intent }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/* ── 插件深链动作(注册面)──────────────────────────────────────────────── */

/**
 * `api.registerDeepLinkAction` 的声明门。装前确认页把这条念给用户听。
 *
 * 它是一个**入站**权限:声明它的插件,可以被应用之外的世界点名。所以披露文案
 * 强调的是"外部链接能唤起它",不是"它能做什么"—— 后者由插件自己用的其它权限
 * (sessions:* / llm:complete / …)各自披露。
 */
export const PLUGIN_PERMISSION_DEEPLINK_HANDLE = 'deeplink:handle'

export const PLUGIN_DEEPLINK_HANDLE_PERMISSION_NOTE =
  'can be invoked by onething:// links from outside the app (you confirm every time)'

/**
 * handler 的超时预算(毫秒)。
 *
 * 比搜索供给方宽得多:这条路径是**用户刚按过确认**的一次性动作,不是键入延迟
 * 敏感路径,插件在里面调一次模型是完全合理的。但它仍然要有上限 —— 一个永不
 * resolve 的 handler 会让那条深链看起来像"什么也没发生"。
 */
export const PLUGIN_DEEPLINK_HANDLER_TIMEOUT_MS = 15_000

/** handler 能给用户说的一句话上限。超出截断 —— 通知不是正文出口。 */
export const PLUGIN_DEEPLINK_NOTICE_MAX_CHARS = 240

/** 交给 handler 的上下文。刻意只有两格:数据 + 参数。 */
export interface CorePluginDeepLinkContext {
  /** URL 里的 `text`,原样。可能是空串。 */
  text: string
  /** 除 `text` 之外的查询参数,原样。 */
  params: Record<string, string>
}

/**
 * handler 的返回值。
 *
 * v1 **不约定复杂协议**:只有一格 `notice`(弹一条通知)。插件要做的其它事
 * ——起一轮对话、开面板、写存储 —— 都靠它自己的 api,各自权限各自管。
 * 把"深链能干什么"塞进返回值形状里,只会长出第二套动词表。
 */
export interface CorePluginDeepLinkResult {
  notice?: string
}

export interface CorePluginDeepLinkActionRegistration {
  /** 动作名(插件内唯一)。`[a-z0-9-]+`;宿主再加 `plugin:<id>:` 前缀做全局地址。 */
  name: string
  /** 确认卡上显示的**人话**。不是 id —— 用户读的是这一句。 */
  title: string
  handler(
    ctx: CorePluginDeepLinkContext,
  ): CorePluginDeepLinkResult | void | Promise<CorePluginDeepLinkResult | void>
}

/**
 * 全局地址:`plugin:<pluginId>:<name>`。
 *
 * 与 registerIMConnector / registerTool 同构 —— 命名空间不由插件自己保证。
 * 熔断车道与降级 surface 都用它,一把尺量到底。
 */
export function pluginDeepLinkAddress(pluginId: string, name: string): string {
  return `plugin:${pluginId}:${name}`
}

/**
 * 降级时停掉的界面名。与 `pluginScope.deepLinkAction` 折出来的 surface
 * (policy.ts 的 `describePluginSurface`)是同一把尺 —— 一边报账、一边据它短路,
 * 不能各写各的。
 */
export function pluginDeepLinkSurface(address: string): string {
  return `deeplink:${address}`
}

/** handler 返回值整形:非对象 → 无 notice;notice 只取字符串并截断。 */
export function normalizePluginDeepLinkResult(raw: unknown): CorePluginDeepLinkResult {
  if (!raw || typeof raw !== 'object') return {}
  const notice = (raw as { notice?: unknown }).notice
  if (typeof notice !== 'string' || !notice.trim()) return {}
  return { notice: notice.trim().slice(0, PLUGIN_DEEPLINK_NOTICE_MAX_CHARS) }
}
