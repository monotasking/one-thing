/**
 * L3 webview 逃生舱的**判据层**(C 期)。
 *
 * 三条裁决落在这里:
 *  1. **静态根是代码区,不是家目录。** `plugins/<id>/` 是数据区(config/kv/storage),
 *     随包分发的静态资产住插件的 `dirPath`(npm 形态即 `plugins/node_modules/<pkg>/`)。
 *     协议服务的根 = `dirPath` + manifest 声明的静态子目录(`contributes.webviewRoot`,
 *     缺省 `webview/`)。rollout §6.2 第 1 条写的"家目录下 dist/"是错的,以此为准。
 *  2. **判据在 core,IO 在宿主。** 这里只做纯字符串的规范化与白名单 ——
 *     core 不吃 node:fs、不吃 electron。真正的 realpath 复核与读文件住在
 *     `apps/electron/src/plugins/protocol.ts`,它拿这里的结论做 join。
 *  3. **插件逻辑代码仍在 main 进程**(redesign §7):iframe 里只有静态文件,
 *     隔离靠独立 origin + CSP + postMessage。webview 不是 ext host 的前置,
 *     也不引入第二个执行模型。
 */

/** 自定义协议的 scheme。`onething-plugin://<pluginId>/<path>`。 */
export const PLUGIN_WEBVIEW_SCHEME = 'onething-plugin'

/** manifest 不声明 `contributes.webviewRoot` 时的静态根(相对 dirPath)。 */
export const PLUGIN_WEBVIEW_DEFAULT_ROOT = 'webview'

/** 面板的呈现形态。缺省 descriptor —— 老 manifest 一个字都不用改。 */
export type PluginPanelView = 'descriptor' | 'webview'

/** 路径字面量的长度闸(声明与 URL 两侧共用)。 */
const MAX_PLUGIN_WEBVIEW_PATH_LENGTH = 256

/**
 * 一段相对路径里**永远**不允许出现的东西。
 *
 * `:` 是这里最要紧的一条:它同时挡掉 `javascript:`、`data:`、`http://` 与
 * Windows 盘符 —— 只校验"以 .html 结尾"挡不住 `javascript:x.html`。
 * `%` 挡的是编码变体(`%2e%2e`),反斜杠挡 Windows 分隔符,控制字符挡 NUL 截断。
 */
// eslint-disable-next-line no-control-regex -- 控制字符正是这条要挡的东西(NUL 截断)
const FORBIDDEN_PATH_CHARS = /[:\\?#%\u0000-\u001f]/

function describeRelativePathProblem(value: unknown, label: string): string | null {
  if (typeof value !== 'string' || !value) return `${label} must be a non-empty string`
  if (value.length > MAX_PLUGIN_WEBVIEW_PATH_LENGTH) {
    return `${label} must be at most ${MAX_PLUGIN_WEBVIEW_PATH_LENGTH} characters`
  }
  if (FORBIDDEN_PATH_CHARS.test(value)) {
    return `${label} must be a plain relative path (no scheme, backslash, query, fragment or percent-encoding)`
  }
  if (value.startsWith('/')) return `${label} must be relative (it must not start with "/")`
  for (const segment of value.split('/')) {
    if (!segment) return `${label} must not contain empty path segments`
    if (segment === '.' || segment === '..') return `${label} must not contain "." or ".." segments`
  }
  return null
}

/**
 * 包内相对资产路径的判据 —— **对外的那一份**。
 *
 * webview entry 与 L2.5 背景图(G 期)共用它:两者都是"插件包里的一个文件,
 * 由 `onething-plugin://` 服务",于是穿越、scheme、编码变体这些判据只能有
 * 一份。背景图那边**只在扩展名白名单上分叉**(图片 vs .html),别的一个字不改 ——
 * 抄第二份就是漂移的开始(与 CSS_VAR_MAP 当白名单同一个道理)。
 */
export function describePluginRelativeAssetPathProblem(value: unknown, label: string): string | null {
  return describeRelativePathProblem(value, label)
}

/** `contributes.webviewRoot` 的判据。undefined = 用缺省根,合法。 */
export function describePluginWebviewRootProblem(root: unknown): string | null {
  if (root === undefined) return null
  return describeRelativePathProblem(root, 'contributes.webviewRoot')
}

/** 静态根(相对 dirPath 的相对路径);非法值不该走到这里(判据先跑)。 */
export function resolvePluginWebviewRoot(root: unknown): string {
  return typeof root === 'string' && root ? root : PLUGIN_WEBVIEW_DEFAULT_ROOT
}

export interface PluginPanelDeclarationLike {
  id?: unknown
  view?: unknown
  entry?: unknown
}

/** 这条面板声明是不是 webview 形态。缺省(未声明 view)= 描述树面板。 */
export function isPluginWebviewPanel(panel: PluginPanelDeclarationLike): boolean {
  return panel?.view === 'webview'
}

/**
 * 一条 `contributes.panels[]` 的 webview 判据。返回错误字符串 = **丢弃该 panel**。
 *
 * 与未知锚点同规:不拒载整个插件,只丢这一条并在清单投影里标出来 ——
 * 拒载的插件根本不进清单,标不出来。
 */
export function describePluginWebviewPanelProblem(
  panel: PluginPanelDeclarationLike,
  webviewRoot?: unknown,
): string | null {
  const view = panel?.view
  if (view === undefined || view === 'descriptor') {
    // 描述树面板不该带 entry —— 带了说明作者以为它会被用上。
    if (panel?.entry !== undefined) return 'entry is only meaningful for a webview panel'
    return null
  }
  if (view !== 'webview') {
    return `view "${String(view)}" is not supported (use "descriptor" or "webview")`
  }
  const rootProblem = describePluginWebviewRootProblem(webviewRoot)
  if (rootProblem) return rootProblem
  const entryProblem = describeRelativePathProblem(panel?.entry, 'entry')
  if (entryProblem) return entryProblem
  if (!/\.html?$/i.test(panel.entry as string)) {
    return 'entry must point at an .html file inside the plugin static root'
  }
  return null
}

// ── 协议服务面 ──────────────────────────────

/**
 * 扩展名 → MIME 白名单。不在表里的一律 415。
 *
 * 白名单而不是嗅探:插件目录里可能躺着 .node / .sh / .env,一条嗅探规则漏掉
 * 就是把它们端上来。svg 留在表里是因为它进的是 sandbox iframe 且带 CSP ——
 * 它里面的脚本跑不起来。
 */
export const PLUGIN_WEBVIEW_MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  woff2: 'font/woff2',
}

/** 文件名 → MIME。null = 不在白名单(调用方回 415)。 */
export function pluginWebviewMimeType(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  return PLUGIN_WEBVIEW_MIME_TYPES[filename.slice(dot + 1).toLowerCase()] ?? null
}

/** 一个插件的 webview origin —— CSP host-source 与 iframe src 共用同一个出处。 */
export function pluginWebviewOrigin(pluginId: string): string {
  return `${PLUGIN_WEBVIEW_SCHEME}://${pluginId}`
}

/** iframe 的 src。 */
export function pluginWebviewEntryUrl(pluginId: string, entry: string): string {
  return `${pluginWebviewOrigin(pluginId)}/${entry.replace(/^\/+/, '')}`
}

/**
 * **数据区路由的保留首段**(B 期,用户壁纸)。
 *
 * 用户导进来的壁纸住数据区(`plugins/<id>/storage/`),而这个文件开头那条
 * "静态根是代码区,不是家目录"的裁决一个字不改 —— 代码区与数据区**不得
 * 互相越界**。问题只是:数据区那张图要怎么被浏览器取到。
 *
 * 三个候选,选了第三个:
 *  1. **第二个 scheme**(`onething-plugin-data://`)。要第二次
 *     `registerSchemesAsPrivileged`、第二个 CSP builder、并且每条 CSP 里多一个
 *     host-source —— 三处必须与第一条同步演进的地方,也就是三处会漂移的地方。
 *  2. **第二个 host**(`onething-plugin://<id>.data/`)。它换了 origin,于是
 *     webview 的 CSP `'self'` / host-source 全部失配,等于 1 的成本再加上一个
 *     "pluginId 里能不能有点"的新坑。
 *  3. **同 scheme、同 host、保留首段**(选中)。一个 scheme、一个 origin、
 *     一份 CSP;代码区与数据区的隔离靠协议 handler 顶上**一条分支**:首段是
 *     `__storage__` 就只查 storage 根,否则只查包根,两条路各自 realpath 复核,
 *     谁也够不到谁。隔离点少一个,能漂移的地方就少一个。
 *
 * 代价是**这个名字被保留了**:插件包里真有一个 `__storage__/` 目录的话,
 * 它里面的文件取不到。双下划线哨兵 + 文档一句话,换隔离面收敛成一条分支。
 */
export const PLUGIN_STORAGE_URL_SEGMENT = '__storage__'

/**
 * 数据区资产的 URL:`onething-plugin://<id>/__storage__/<相对 storage 根的路径>`。
 *
 * 与 `pluginWebviewEntryUrl` 同一个 origin —— 见 PLUGIN_STORAGE_URL_SEGMENT。
 */
export function pluginStorageAssetUrl(pluginId: string, relativePath: string): string {
  return `${pluginWebviewOrigin(pluginId)}/${PLUGIN_STORAGE_URL_SEGMENT}/${relativePath.replace(/^\/+/, '')}`
}

/**
 * 响应头里的 CSP。
 *
 * **`'self'` 与 host-source 都写,因为实测两种都放行。**
 *
 * C 期开工时的担心是:`sandbox="allow-scripts"`(无 `allow-same-origin`)的 iframe
 * 是 opaque origin,而 `'self'` 按 origin 匹配 —— opaque origin 可能匹配不到任何
 * 东西,于是同目录的 `app.js` 会被自己的 CSP 挡掉。**在 Electron 里实测,这个
 * 担心不成立**:Chromium 计算 `'self'` 用的是 policy 的 self-origin(= 响应 URL
 * 的 origin),不是文档那个 opaque origin,所以沙箱 iframe 里 `script-src 'self'`
 * 照常放行同源脚本。对照组 `script-src 'none'` 当场被挡,证明 CSP 确实挂上了。
 *
 * 两条都留:host-source `onething-plugin://<pluginId>` 是不依赖上述实现细节的
 * 那一条(CSP host-source 按 URL 的 scheme/host 比对,与文档 origin 无关),
 * `'self'` 是零成本的第二保险。实测记录见
 * docs/design/plugin-ui/plugin-ui-rollout-2026-08.md §6.3。
 *
 * `connect-src 'none'`:iframe 里的 JS **不能出网**,通信的唯一通道是 postMessage。
 */
export function buildPluginWebviewCsp(pluginId: string): string {
  const origin = pluginWebviewOrigin(pluginId)
  return [
    "default-src 'none'",
    `script-src 'self' ${origin}`,
    `style-src 'self' ${origin} 'unsafe-inline'`,
    `img-src 'self' ${origin} data:`,
    `font-src 'self' ${origin}`,
    `media-src 'self' ${origin}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/**
 * URL 路径 → 静态根内的相对片段。返回 null = 拒绝(404)。
 *
 * 输入是**已经 decodeURIComponent 过一次**的 pathname:`%2e%2e` 在 URL 解析期
 * 不会被 Chromium 规范化(百分号编码的点原样保留),所以穿越检查必须发生在
 * 解码之后 —— 只看未解码的 pathname 等于没检查。
 *
 * 目录请求(空路径 / 以 `/` 结尾)一律拒绝:这个协议不做目录索引,也不隐式
 * 补 index.html —— entry 是 manifest 里写死的,没有第二条进入路径。
 */
export function resolvePluginWebviewRequestSegments(decodedPath: string): string[] | null {
  if (typeof decodedPath !== 'string') return null
  if (decodedPath.length > MAX_PLUGIN_WEBVIEW_PATH_LENGTH) return null
  // 反斜杠与控制字符(含 NUL 截断)在任何平台上都不该出现在这条协议的路径里。
  // eslint-disable-next-line no-control-regex -- 控制字符正是这条要挡的东西(NUL 截断)
  if (/[\\\u0000-\u001f]/.test(decodedPath)) return null
  const segments: string[] = []
  for (const raw of decodedPath.split('/')) {
    if (!raw || raw === '.') continue
    // `..` 在这里止步 —— 不做"消一层"的宽容处理:一个正经的静态资源请求
    // 永远不需要往上走,出现即恶意。
    if (raw === '..') return null
    segments.push(raw)
  }
  if (!segments.length) return null
  return segments
}

// ── 宿主 ⇄ iframe 的消息协议 ─────────────────────

/**
 * host → iframe 的两条消息(首帧握手 + 重拉)与 iframe → host 的三条。
 *
 * **token 是唯一的身份凭据**:opaque origin 下 `event.origin` 是字符串 `"null"`,
 * 校验它等于没校验。宿主认的是 `event.source === iframe.contentWindow`
 * **加上**一次性 token —— 前者挡别的 frame,后者挡同一 frame 里的旧世代。
 */
export const PLUGIN_WEBVIEW_MESSAGE_TYPES = {
  /** host → iframe:首帧握手,带 token 与初始化数据。 */
  init: 'init',
  /** host → iframe:插件调了 ctx.refresh(),宿主重拉初始化数据后推来。 */
  refresh: 'refresh',
  /** iframe → host:握手确认(宿主据此判定页面真的起来了)。 */
  ready: 'ready',
  /** iframe → host:调一个 action,走既有 `panel:action:<panelId>` 通道。 */
  invoke: 'invoke',
  /** host → iframe:invoke 的回帖。 */
  result: 'result',
} as const
