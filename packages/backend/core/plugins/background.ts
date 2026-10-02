/**
 * `contributes.theme.background` —— L2.5 背景/材质层的**判据与裁决**(G 期,见
 * `docs/design/plugin-ui/plugin-ui-expression-layers-2026-08.md` §3.3.5)。
 *
 * 三件事在这里,而且只在这里:
 *
 *  1. **图源不是任意 URL,是包内资产。** L2 的颜色白名单刻意禁了 `url()` ——
 *     那条禁令针对的是"任意 URL"(远程加载 / 追踪像素 / 指纹),对包内文件不成立:
 *     C 期的 `onething-plugin://<id>/` 只服务**已启用插件**的静态根,天然是安全图源。
 *     于是背景能力不必打破任何红线,判据直接复用 webview entry 那一份
 *     (`describePluginRelativeAssetPathProblem`),**只在扩展名白名单上分叉**。
 *
 *  2. **参数是枚举出来的三个旋钮**(opacity / blur / fit),不是 CSS 片段。
 *     背景层是"枚举出的一块宿主自留地",不是 CSS 注入的口子 —— 想要别的效果的
 *     正确出口是 L3 webview,不是往这里加第四个字符串字段。
 *
 *  3. **冲突按全局规范顺序后者胜**,与 token 覆盖同一出处
 *     (`comparePluginCanonicalOrder`)。停用的插件不参与裁决 —— 否则关掉一个插件
 *     会改变另一个插件的呈现状态。
 *
 * **声明严、运行期宽**(有意的不对称):
 *  - manifest 里的越界数值(opacity 5、blur 999)**当场判非法并丢弃整条 background**。
 *    它是作者写死的常量,设置页看得见,说出来才有人去改;悄悄钳一下等于把
 *    "作者理解错了"藏起来。
 *  - `api.theme.updateBackground(partial)` 里的越界数值**钳制**。它是用户拖滑杆的
 *    结果,拒绝一次拖拽换来的是一个卡住的控件,而钳住正是用户期待的行为。
 *
 * 判据在 core、IO 在宿主:这里一行 fs / electron 都不吃,真正的读文件仍住在
 * `apps/electron/src/plugins/protocol.ts`(与 webview 同一条协议、同一批闸)。
 */
import { comparePluginCanonicalOrder } from './canonical-order.js'
import {
  describePluginRelativeAssetPathProblem,
  pluginStorageAssetUrl,
  pluginWebviewEntryUrl,
} from './webview.js'

/**
 * 背景图允许的扩展名。
 *
 * 是 `PLUGIN_WEBVIEW_MIME_TYPES` 的**图片子集**:协议那边已经按 MIME 白名单
 * 放行了这些扩展名,这里只是把"能当背景的"再收一道 —— 声明一个 `.js` 当背景图
 * 是作者写错了,不该等到浏览器解码失败才发现。
 *
 * `svg` 留着:它进的是 CSS `background-image`,不是 `<img>` 也不是 iframe ——
 * CSS 背景里的 SVG 不执行脚本、不发外链请求(浏览器按 secure-static 模式解析)。
 */
export const PLUGIN_BACKGROUND_IMAGE_EXTENSIONS: readonly string[] = [
  'png', 'jpg', 'jpeg', 'webp', 'svg', 'gif',
]

/** 铺放方式。cover/contain 映射 background-size,tile 映射 repeat。 */
export const PLUGIN_BACKGROUND_FITS = ['cover', 'contain', 'tile'] as const
export type PluginBackgroundFit = (typeof PLUGIN_BACKGROUND_FITS)[number]

export const PLUGIN_BACKGROUND_DEFAULT_OPACITY = 1
export const PLUGIN_BACKGROUND_DEFAULT_BLUR = 0
export const PLUGIN_BACKGROUND_DEFAULT_FIT: PluginBackgroundFit = 'cover'
export const PLUGIN_BACKGROUND_MIN_OPACITY = 0
export const PLUGIN_BACKGROUND_MAX_OPACITY = 1
export const PLUGIN_BACKGROUND_MIN_BLUR = 0
/** 上限 40px:再高就只是一块糊,而 filter: blur 的代价随半径平方上涨。 */
export const PLUGIN_BACKGROUND_MAX_BLUR = 40

/** 三个旋钮的完整取值(缺省已填)。 */
export interface PluginBackgroundParams {
  opacity: number
  blur: number
  fit: PluginBackgroundFit
}

/**
 * 运行期可调的那一部分。
 *
 * **image 的值域是 `storage:` 那一格,不是任意路径**(B 期,用户壁纸)。
 * 包内换图仍然等于发新版本 —— 那条语义一个字没变:`image` 在这里只接受
 * `storage:<相对 storage 根的路径>`,指向的是**用户自己导进来的**那张图
 * (经 `file-pick` 由宿主拷进 `plugins/<id>/storage/imports/`)。
 * 一条相对包根的路径(`bg/paper.png`)在这里会被拒 —— 想换包内那张图,
 * 改 manifest、发版本。
 *
 * **`image: null` = 撤回运行期图**(恢复默认闭环,2026-08-10)。三格值域,
 * 缺一格就没有回头路:
 *  - `undefined` —— 这次不动 image(半条补丁,与 opacity 同规);
 *  - `'storage:<rel>'` —— 换成用户导进来的那张;
 *  - `null` —— 撤回,背景回落 manifest 声明的缺省图(`darkImage` 一并恢复)。
 * 没有第三格时,插件把运行期图撤回缺省的唯一办法是重启宿主 —— 那不是一条
 * 出口,那是没有出口。
 */
export interface PluginBackgroundParamsPatch {
  opacity?: number
  blur?: number
  fit?: PluginBackgroundFit
  /** 仅 `storage:` 前缀;`null` = 撤回运行期图。见上。 */
  image?: string | null
}

/** manifest 里的声明形状(未校验)。 */
export interface PluginBackgroundDeclarationLike {
  image?: unknown
  darkImage?: unknown
  opacity?: unknown
  blur?: unknown
  fit?: unknown
}

export const PLUGIN_BACKGROUND_DEFAULT_PARAMS: PluginBackgroundParams = {
  opacity: PLUGIN_BACKGROUND_DEFAULT_OPACITY,
  blur: PLUGIN_BACKGROUND_DEFAULT_BLUR,
  fit: PLUGIN_BACKGROUND_DEFAULT_FIT,
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 文件名的扩展名(小写);没有扩展名时返回 ''。 */
function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.')
  if (dot < 0) return ''
  return value.slice(dot + 1).toLowerCase()
}

/** 背景图路径的判据 = webview entry 的那一份 + 图片扩展名白名单。 */
function describeBackgroundImageProblem(value: unknown, label: string): string | null {
  const problem = describePluginRelativeAssetPathProblem(value, label)
  if (problem) return problem
  if (!PLUGIN_BACKGROUND_IMAGE_EXTENSIONS.includes(extensionOf(value as string))) {
    return `${label} must point at an image file (${PLUGIN_BACKGROUND_IMAGE_EXTENSIONS.join(', ')})`
  }
  return null
}

/**
 * 运行期换图的寻址前缀。`storage:imports/paper.png` →
 * `plugins/<id>/storage/imports/paper.png`。
 *
 * 为什么是一个前缀而不是"第二个字段":`image` 的语义(哪张图当背景)没变,
 * 变的只是**这张图住哪个区**。两个字段意味着两处都要判"谁赢",而背景只有
 * 一块 —— 那份裁决没有第二个正确答案,只有两处会写歪的地方。
 */
export const PLUGIN_STORAGE_IMAGE_PREFIX = 'storage:'

/** 是不是一条 `storage:` 寻址。 */
export function isPluginStorageImageRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PLUGIN_STORAGE_IMAGE_PREFIX)
}

/**
 * `storage:<rel>` → `<rel>`。非法(不是 storage: 前缀 / 路径判据不过 /
 * 扩展名不在白名单)一律 null。
 *
 * 路径判据复用**包内资产那一份**(穿越、scheme、编码变体、绝对路径),
 * 只在"相对哪个根"上分叉 —— 抄第二份就是漂移的开始。
 */
export function parsePluginStorageImageRef(value: unknown): string | null {
  if (!isPluginStorageImageRef(value)) return null
  const relative = value.slice(PLUGIN_STORAGE_IMAGE_PREFIX.length)
  return describeBackgroundImageProblem(relative, 'image') ? null : relative
}

/**
 * 运行期 `image` 的判据。返回错误字符串 = **拒掉这一次 updateBackground**
 * (不是丢一个字段:插件明说了"把背景换成这张",半条命令比不执行更难解释)。
 *
 * 判的是"这张图能不能当背景",所以它只接**一张图**:`null`(撤回)根本没有
 * 图源可判,由调用方在进这道门之前分流(api-builder 与 clamp 各有一处)。
 * 把"没有图"塞进图源判据里,等于让同一个函数同时回答两个问题。
 */
export function describePluginRuntimeBackgroundImageProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value) {
    return 'image must be a non-empty string'
  }
  if (!isPluginStorageImageRef(value)) {
    return `image must start with "${PLUGIN_STORAGE_IMAGE_PREFIX}" `
      + '(package assets are swapped by shipping a new version, not at runtime)'
  }
  const relative = value.slice(PLUGIN_STORAGE_IMAGE_PREFIX.length)
  return describeBackgroundImageProblem(relative, 'image')
}

export function isPluginBackgroundFit(value: unknown): value is PluginBackgroundFit {
  return typeof value === 'string'
    && (PLUGIN_BACKGROUND_FITS as readonly string[]).includes(value)
}

function describeNumberProblem(
  value: unknown,
  label: string,
  min: number,
  max: number,
): string | null {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${label} must be a finite number`
  }
  if (value < min || value > max) return `${label} must be between ${min} and ${max}`
  return null
}

/**
 * 一条 `contributes.theme.background` 声明的判据。
 *
 * 返回错误字符串 = **丢弃 background**(不拒载整个插件,与未知锚点 / token 覆盖
 * 同规:降级不拒载,不计熔断 —— 拒载的插件根本不进清单,理由就没地方说)。
 * `undefined` = 没声明,合法。
 */
export function describePluginBackgroundProblem(background: unknown): string | null {
  if (background === undefined) return null
  if (!isPlainRecord(background)) return 'contributes.theme.background must be an object'
  const imageProblem = describeBackgroundImageProblem(
    background.image,
    'contributes.theme.background.image',
  )
  if (imageProblem) return imageProblem
  if (background.darkImage !== undefined) {
    const darkProblem = describeBackgroundImageProblem(
      background.darkImage,
      'contributes.theme.background.darkImage',
    )
    if (darkProblem) return darkProblem
  }
  const opacityProblem = describeNumberProblem(
    background.opacity,
    'contributes.theme.background.opacity',
    PLUGIN_BACKGROUND_MIN_OPACITY,
    PLUGIN_BACKGROUND_MAX_OPACITY,
  )
  if (opacityProblem) return opacityProblem
  const blurProblem = describeNumberProblem(
    background.blur,
    'contributes.theme.background.blur',
    PLUGIN_BACKGROUND_MIN_BLUR,
    PLUGIN_BACKGROUND_MAX_BLUR,
  )
  if (blurProblem) return blurProblem
  if (background.fit !== undefined && !isPluginBackgroundFit(background.fit)) {
    return `contributes.theme.background.fit must be one of ${PLUGIN_BACKGROUND_FITS.join(', ')}`
  }
  return null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 运行期补丁的钳制。
 *
 * 非数字 / NaN / 未知 fit 一律**忽略该字段**(保留上一次的值),越界数字钳进区间。
 *
 * `image` 是这里唯一的**非**钳制字段:合法的 `storage:` 寻址留下,别的一律丢。
 * 真正拒掉整条调用的判断在 `api.theme.updateBackground`
 * (`describePluginRuntimeBackgroundImageProblem`)—— 这里这一道是兜底:
 * 任何绕开 api-builder 的登记路径(第二个宿主、直接写 runtimeParams 的测试
 * 替身)都不该能把一条包内路径塞进背景的图源。
 *
 * `image: null`(撤回)**原样留下**,不能当成"没提过"丢掉:内存态是**合并**
 * 存的(`{...previous, ...patch}`),丢了这个键上一张图就会继续赢 —— 撤回会
 * 变成一次静默的空操作。
 */
export function clampPluginBackgroundParamsPatch(
  patch: unknown,
): PluginBackgroundParamsPatch {
  if (!isPlainRecord(patch)) return {}
  const result: PluginBackgroundParamsPatch = {}
  if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity)) {
    result.opacity = clamp(patch.opacity, PLUGIN_BACKGROUND_MIN_OPACITY, PLUGIN_BACKGROUND_MAX_OPACITY)
  }
  if (typeof patch.blur === 'number' && Number.isFinite(patch.blur)) {
    result.blur = clamp(patch.blur, PLUGIN_BACKGROUND_MIN_BLUR, PLUGIN_BACKGROUND_MAX_BLUR)
  }
  if (isPluginBackgroundFit(patch.fit)) result.fit = patch.fit
  if (patch.image === null) {
    result.image = null
  } else if (patch.image !== undefined && !describePluginRuntimeBackgroundImageProblem(patch.image)) {
    result.image = patch.image as string
  }
  return result
}

/** manifest 缺省 ⊕ 最新一次 updateBackground。声明先于代码:缺省来自 manifest。 */
export function mergePluginBackgroundParams(
  declaration: PluginBackgroundDeclarationLike,
  patch?: PluginBackgroundParamsPatch | null,
): PluginBackgroundParams {
  return {
    opacity: patch?.opacity
      ?? (typeof declaration.opacity === 'number'
        ? declaration.opacity
        : PLUGIN_BACKGROUND_DEFAULT_OPACITY),
    blur: patch?.blur
      ?? (typeof declaration.blur === 'number'
        ? declaration.blur
        : PLUGIN_BACKGROUND_DEFAULT_BLUR),
    fit: patch?.fit
      ?? (isPluginBackgroundFit(declaration.fit)
        ? declaration.fit
        : PLUGIN_BACKGROUND_DEFAULT_FIT),
  }
}

/**
 * 背景图的 URL —— 与 webview entry **同一个出处**。
 *
 * 路径相对**静态根**(`contributes.webviewRoot`,缺省 `webview/`),协议那边
 * join 的时候会补上根,所以 URL 里不带根这一段。
 *
 * `storage:` 寻址走**数据区路由**(`__storage__` 保留首段,见 webview.ts):
 * 同一个 scheme、同一个 origin,协议 handler 顶上一条分支决定查哪个根。
 * 分叉在这一个函数里,是因为"图源在哪个区"只有这一处知道 —— 让 renderer
 * 或协议 handler 自己去认那个前缀,就等于把同一份判据抄第二遍。
 */
export function pluginBackgroundImageUrl(pluginId: string, image: string): string {
  const storageRelative = parsePluginStorageImageRef(image)
  if (storageRelative) return pluginStorageAssetUrl(pluginId, storageRelative)
  return pluginWebviewEntryUrl(pluginId, image)
}

/** 一条背景声明在裁决后的状态(与 token 覆盖的四态同名同义)。 */
export type PluginBackgroundStatus =
  /** 生效中:此刻画在背景层上的就是它。 */
  | 'active'
  /** 被更后者压过:合法,但规范顺序更靠后的插件也声明了背景。 */
  | 'shadowed'
  /** 插件未启用:声明还在,但不参与合成。 */
  | 'inactive'
  /** 声明非法 —— 丢弃,但设置页要说得出来。 */
  | 'invalid'

/** 逐插件的裁决结果(设置页明细用)。 */
export interface PluginBackgroundEntry {
  status: PluginBackgroundStatus
  /** 相对静态根的图路径(原样;invalid 时可能是空串)。 */
  image: string
  darkImage: string
  opacity: number
  blur: number
  fit: PluginBackgroundFit
  /** status === 'invalid' 时的人话原因。 */
  reason?: string
  /** status === 'shadowed' 时压过它的那个插件 id。 */
  shadowedBy?: string
}

/** 胜出的那一条 —— renderer 拿它直接画层,不再做第二次判断。 */
export interface PluginBackgroundDescriptor {
  pluginId: string
  /** `onething-plugin://<id>/<image>` 完整 URL。 */
  imageUrl: string
  /** 深色图;插件没声明 darkImage 时**等于** imageUrl(renderer 不做兜底)。 */
  darkImageUrl: string
  opacity: number
  blur: number
  fit: PluginBackgroundFit
}

export interface PluginBackgroundInput {
  pluginId: string
  enabled: boolean
  /** manifest 的 `contributes.theme.background`(未校验原文)。 */
  background?: unknown
  /** 该插件最近一次 `api.theme.updateBackground` 的结果(内存态,可空)。 */
  runtimeParams?: PluginBackgroundParamsPatch | null
}

export interface PluginBackgroundResolution {
  /** 逐插件裁决(键 = pluginId);没声明背景的插件不出现在表里。 */
  byPlugin: Map<string, PluginBackgroundEntry>
  /** 胜出的背景;没有任何一条 active 时是 null。 */
  winner: PluginBackgroundDescriptor | null
}

/**
 * 裁决一组插件的背景声明。
 *
 * 顺序语义与 token 覆盖逐字相同:先按全局规范顺序排,再顺序写入 —— 后写的赢,
 * 被赢掉的那条标 `shadowed` 并记下赢家。**背景只有一块**,所以这里的"同一个 token"
 * 就是全局唯一那一格。
 */
export function resolvePluginBackgrounds(
  inputs: readonly PluginBackgroundInput[],
): PluginBackgroundResolution {
  const ordered = [...inputs].sort((a, b) => comparePluginCanonicalOrder(a.pluginId, b.pluginId))
  const byPlugin = new Map<string, PluginBackgroundEntry>()
  let winner: { pluginId: string; entry: PluginBackgroundEntry } | null = null

  for (const input of ordered) {
    if (input.background === undefined) continue
    const problem = describePluginBackgroundProblem(input.background)
    if (problem) {
      const raw = isPlainRecord(input.background) ? input.background : {}
      byPlugin.set(input.pluginId, {
        status: 'invalid',
        reason: problem,
        image: typeof raw.image === 'string' ? raw.image : '',
        darkImage: typeof raw.darkImage === 'string' ? raw.darkImage : '',
        ...PLUGIN_BACKGROUND_DEFAULT_PARAMS,
      })
      continue
    }
    const declaration = input.background as PluginBackgroundDeclarationLike
    const runtime = clampPluginBackgroundParamsPatch(input.runtimeParams ?? undefined)
    const params = mergePluginBackgroundParams(declaration, runtime)
    // 用户导入的壁纸压过 manifest 缺省图(声明是**缺省**,不是终值)。
    // darkImage 随之清空:用户挑的是"这一张",不是"浅色这一张" ——
    // 留着包里的深色图会让同一次选择在切主题时换成另一幅画。
    //
    // 撤回(`image: null`)走的就是这两行的**另一支**:图回落 manifest 缺省,
    // darkImage 一并恢复。接管是成对的,撤销也必须成对 —— 只还回浅色图、
    // 深色仍是空,等于把"恢复默认"做成了半张。
    const image = runtime.image ?? (declaration.image as string)
    const darkImage = runtime.image
      ? ''
      : (typeof declaration.darkImage === 'string' ? declaration.darkImage : '')
    if (!input.enabled) {
      byPlugin.set(input.pluginId, { status: 'inactive', image, darkImage, ...params })
      continue
    }
    const entry: PluginBackgroundEntry = { status: 'active', image, darkImage, ...params }
    if (winner) {
      winner.entry.status = 'shadowed'
      winner.entry.shadowedBy = input.pluginId
    }
    winner = { pluginId: input.pluginId, entry }
    byPlugin.set(input.pluginId, entry)
  }

  return {
    byPlugin,
    winner: winner
      ? {
        pluginId: winner.pluginId,
        imageUrl: pluginBackgroundImageUrl(winner.pluginId, winner.entry.image),
        darkImageUrl: pluginBackgroundImageUrl(
          winner.pluginId,
          winner.entry.darkImage || winner.entry.image,
        ),
        opacity: winner.entry.opacity,
        blur: winner.entry.blur,
        fit: winner.entry.fit,
      }
      : null,
  }
}
