/**
 * `file-pick` 描述树节点的**判据层**(B 期,用户壁纸)。
 *
 * 核心裁决只有一条,别的全是它的推论:**字节不过插件的手**。
 *
 * 插件声明一个 `file-pick` 节点,宿主画一个按钮;点下去走宿主自己的原生
 * 文件对话框,宿主校验、宿主拷贝进这个插件的数据目录,最后只把一个
 * **地址**(`storage:imports/<name>`)递回给插件。插件从头到尾拿不到
 * 用户磁盘上的路径,更拿不到文件内容 —— 于是"选一张壁纸"这件事不需要
 * 给插件开任何读文件的权限,也不需要一条 base64 过 IPC 的胖通道。
 *
 * 手势锚定是**天然**的,不是靠一个 `userGesture` 布尔:原生对话框只能由
 * 用户的那一次点击拉起来,插件不能自己"调用一次 file-pick"。这与
 * `input-intercept` 那条手势闸的不同在于,这里根本没有可伪造的入口。
 *
 * 判据在 core、IO 在宿主(与 webview / 背景层逐字同构):这里一行 fs 都不吃,
 * 真正的对话框住 Electron 宿主的插件 IPC 面,真正的拷贝住装配层的
 * `app/plugins/file-import.ts`。
 */
import { PLUGIN_BACKGROUND_IMAGE_EXTENSIONS } from './background.js'

/**
 * 可导入的扩展名白名单 —— **就是背景图那一份**,不是第二份表。
 *
 * 今天 `file-pick` 唯一的下游是壁纸管线(导进来的文件最终要被
 * `onething-plugin://<id>/__storage__/…` 端出去当背景),所以两张表必须
 * 是同一张:一边放行 `.bmp` 而另一边不服务它,得到的是一个导入成功却
 * 画不出来的壁纸,而两边都"看着对"。
 *
 * 将来若有第二类导入(字体?音频?),那是一次新的裁决 —— 加一个
 * `kind` 字段并在这里分叉,而不是把这张表悄悄撑大。
 */
export const PLUGIN_FILE_PICK_EXTENSIONS: readonly string[] = PLUGIN_BACKGROUND_IMAGE_EXTENSIONS

/**
 * 单文件硬顶 10MB。
 *
 * 插件声明的 `maxBytes` **只能更小**:声明更大按这个数算(钳制,不拒绝)——
 * 它不是作者的一个笔误,而是作者想要更大而宿主不给,把节点整个拒掉换来的
 * 只是一个用不了的面板。真正该拒的是"声明了一个不是正数的上限"。
 */
export const PLUGIN_FILE_PICK_MAX_BYTES = 10 * 1024 * 1024

/** 导入落点的子目录:`plugins/<id>/storage/imports/`。 */
export const PLUGIN_IMPORTS_DIR_NAME = 'imports'

/**
 * `contributes.settings.schema` 里声明"选文件"控件用的 `format` 值。
 *
 * **为什么设置页也要有这个入口**(用户批评驱动的裁决):选一张壁纸是**配置**,
 * 配置的家是设置页;面板留给活内容。此前宿主的 schema 子集没有文件控件,
 * 于是"选图"这件事被 file-pick 节点的渲染位置一路拽进了工作台面板 ——
 * 能力缺口把 UX 拽错了位置,不是作者选错了地方。
 *
 * 落在 `format` 而不是一个自造的键:`format` 是 JSON Schema 自己的扩展位,
 * 不认识它的读者(别的校验器、编辑器补全)按规范**忽略**它,于是这条声明
 * 在别处退化成一个普通的 string 字段,而不是一个"非法的 schema"。
 *
 * 语义与 file-pick 节点**逐字相同**:字节不过插件的手,插件只拿到
 * `storage:imports/<name>` 这个地址;`accept` 只能收窄宿主白名单,
 * `maxBytes` 被硬顶钳住。判据也是同一份(见
 * `describePluginFileImportDeclarationProblem`)。
 */
export const PLUGIN_SETTINGS_FILE_IMPORT_FORMAT = 'file-import'

/**
 * `contributes.settings.schema` 里声明"选一个目录"控件用的 `format` 值(F1 第二根)。
 *
 * **与 `file-import` 同住这个文件**,因为它们是同一件事的两半:宿主拉起一个原生
 * 对话框、宿主校验、插件只拿到一个**地址**。区别只在拿到的是什么地址:
 * `file-import` 拿 `storage:imports/<name>`(字节进了插件的家目录),
 * `directory-pick` 拿一个**用户磁盘上的绝对路径** —— 所以它必须配一道独立权限
 * (`storage:external-root`),而 file-import 不需要任何权限。
 *
 * 落在 `format` 而不是自造的键,理由与 file-import 逐字相同:不认识它的读者按
 * JSON Schema 规范**忽略**它,于是这条声明在别处退化成一个普通 string 字段,
 * 而不是一份"非法的 schema"。
 *
 * 校验分三层,一层都不能省也一层都不越界:
 *  1. **声明**(本文件,纯函数):不能配 enum、只能落在 string 上、
 *     manifest 不许预填一个目录;
 *  2. **值的形状**(`runtime/plugins/config-schema.ts`,纯函数):必须是绝对路径
 *     或空串。**这里不 stat** —— 产品层不吃 fs,而设置页也要用同一份校验;
 *  3. **存在性**(`core/plugins/storage-files.ts`,用到的那一刻):目录必须存在
 *     且是目录,否则结构化 `not-configured`。用户可能在选完之后把它删了/改名了,
 *     而那不是"配置非法",是"现在够不着"。
 */
export const PLUGIN_SETTINGS_DIRECTORY_PICK_FORMAT = 'directory-pick'

/**
 * 一条 `format: 'directory-pick'` 声明的判据。返回错误字符串 = 整个配置区标不支持
 * (与 file-import 同规:不炸加载,只把这份 schema 判成渲染不了)。
 */
export function describePluginDirectoryPickDeclarationProblem(
  declaration: { type?: unknown; enum?: unknown; default?: unknown },
  path: string,
): string | null {
  if (declaration.enum !== undefined) {
    return `${path}: format "${PLUGIN_SETTINGS_DIRECTORY_PICK_FORMAT}" cannot be combined with enum`
  }
  if (declaration.type !== undefined && declaration.type !== 'string') {
    return `${path}: format "${PLUGIN_SETTINGS_DIRECTORY_PICK_FORMAT}" is only supported on string properties `
      + '(the stored value is an absolute directory path)'
  }
  // **manifest 不许预填目录。** 一个默认值为 `/Users/x/notes` 的字段,等于插件替
  // 用户选好了一个目录 —— 而这条权限的全部意义就是"目录由用户选"。
  if (declaration.default !== undefined && declaration.default !== '') {
    return `${path}: format "${PLUGIN_SETTINGS_DIRECTORY_PICK_FORMAT}" cannot declare a default `
      + '(the folder is the user\'s to choose)'
  }
  return null
}

/** 清洗后文件名主干的长度上限(扩展名另算)。 */
const MAX_IMPORT_STEM_LENGTH = 64

/** 防重命名时最多试多少次(试完仍撞名 = 放弃,由调用方报 io 错)。 */
const MAX_IMPORT_NAME_ATTEMPTS = 1000

export interface PluginFilePickNodeLike {
  label?: unknown
  accept?: unknown
  maxBytes?: unknown
  actionId?: unknown
}

/** 宿主递给插件的 onAction payload —— **地址,不是字节**。 */
export interface PluginFilePickResult {
  /** `storage:imports/<name>`，可直接喂给 `api.theme.updateBackground({ image })`。 */
  path: string
  /** 清洗后的落盘文件名(不是用户磁盘上的原名 —— 那会泄露目录结构)。 */
  name: string
  size: number
}

function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.')
  if (dot < 0) return ''
  return value.slice(dot + 1).toLowerCase()
}

/**
 * 一条 `file-pick` 节点声明的判据(描述树校验层调用)。
 *
 * 与其余节点类型同构:返回错误字符串 = **整棵树拒收**。这里不搞"该节点降级",
 * 因为描述树没有半棵树的概念 —— 一个画不出来的按钮留在面板上,用户点下去
 * 毫无反应,而这正是描述树校验一开始要消灭的那种事故。
 *
 * 唯一被**钳**而不是被拒的是 `maxBytes`(见 PLUGIN_FILE_PICK_MAX_BYTES)。
 */
export function describePluginFilePickNodeProblem(
  node: PluginFilePickNodeLike,
  path: string,
): string | null {
  if (typeof node.label !== 'string' || !node.label) {
    return `${path}.label must be a non-empty string`
  }
  if (typeof node.actionId !== 'string' || !node.actionId) {
    // 与 button 同规:回调靠 actionId 寻址,不是塞一个闭包。
    return `${path}.actionId must be a non-empty string (file-pick addresses actions by id, not by callback)`
  }
  return describePluginFileImportDeclarationProblem(node, path)
}

/**
 * `accept` / `maxBytes` 这一对声明的判据 —— **面板节点与设置页 schema 共用这一份**。
 *
 * 抽出来不是为了少写几行:两处各写一份,今天逐字相同,明天白名单变了就只改
 * 一边,得到的是"面板里能导入、设置页说不支持"这种没人能解释的分裂。
 *
 * 两条语义各自的裁决没有变:
 *  - `accept` **只能收窄**宿主白名单,越界 = 拒(不是悄悄过滤);
 *  - `maxBytes` 只挡"不是正数",声明得比硬顶大**不是错**,由
 *    `clampPluginFilePickMaxBytes` 收(见 PLUGIN_FILE_PICK_MAX_BYTES 的裁决)。
 */
export function describePluginFileImportDeclarationProblem(
  declaration: { accept?: unknown; maxBytes?: unknown },
  path: string,
): string | null {
  const accept = declaration.accept
  if (accept !== undefined) {
    if (!Array.isArray(accept) || accept.length === 0) {
      return `${path}.accept must be a non-empty array of file extensions`
    }
    for (const item of accept) {
      if (typeof item !== 'string' || !item) {
        return `${path}.accept entries must be non-empty strings`
      }
      // **只能收窄**:accept 是插件在宿主白名单里挑一个子集,不是往里加东西。
      if (!PLUGIN_FILE_PICK_EXTENSIONS.includes(item.toLowerCase())) {
        return `${path}.accept entry "${item}" is outside the host whitelist `
          + `(${PLUGIN_FILE_PICK_EXTENSIONS.join(', ')}); accept can only narrow it`
      }
    }
  }
  const maxBytes = declaration.maxBytes
  if (maxBytes !== undefined) {
    if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      return `${path}.maxBytes must be a positive finite number`
    }
  }
  return null
}

/** 声明的 accept ⊕ 宿主白名单。缺省(未声明)= 全白名单。 */
export function resolvePluginFilePickAccept(accept: unknown): string[] {
  if (!Array.isArray(accept) || !accept.length) return [...PLUGIN_FILE_PICK_EXTENSIONS]
  const narrowed = accept
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.toLowerCase())
    .filter(item => PLUGIN_FILE_PICK_EXTENSIONS.includes(item))
  return narrowed.length ? [...new Set(narrowed)] : [...PLUGIN_FILE_PICK_EXTENSIONS]
}

/** 声明的 maxBytes ⊕ 宿主硬顶。声明更大按硬顶算;没声明 = 硬顶。 */
export function clampPluginFilePickMaxBytes(maxBytes: unknown): number {
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return PLUGIN_FILE_PICK_MAX_BYTES
  }
  return Math.min(Math.floor(maxBytes), PLUGIN_FILE_PICK_MAX_BYTES)
}

/**
 * 落盘文件名的清洗:**只留 `[a-zA-Z0-9._-]`**。
 *
 * 用户磁盘上的原名会带空格、中文、`%`、甚至换行 —— 它最终要拼进一个
 * `onething-plugin://` URL,也要拼进一条文件系统路径,两边各有各的解释规则。
 * 与其在两处各写一套转义,不如在**唯一的入口**把名字收成一个两边都无歧义
 * 的字符集(与 webview 路径判据同一个思路:收窄,不是转义)。
 *
 * 主干被清空(比如全中文名)时回落到 `fallbackStem`,而不是产出一个
 * 以 `.` 开头的隐藏文件。`.` / `..` 同样在这里止步。
 */
export function sanitizePluginImportFileName(rawName: unknown, fallbackStem = 'import'): string {
  const raw = typeof rawName === 'string' ? rawName : ''
  // 分隔符两种都切:用户可能在 Windows 上选的文件,而这个函数不认识平台。
  const base = raw.split(/[/\\]/).pop() ?? ''
  const extension = extensionOf(base).replace(/[^a-z0-9]/g, '')
  const stemSource = extension ? base.slice(0, base.length - extension.length - 1) : base
  let stem = stemSource.replace(/[^a-zA-Z0-9._-]/g, '').replace(/^\.+/, '').slice(0, MAX_IMPORT_STEM_LENGTH)
  if (!stem || stem === '.' || stem === '..') stem = fallbackStem
  return extension ? `${stem}.${extension}` : stem
}

/**
 * 防覆盖:同名时加 `-2` / `-3` … 后缀。
 *
 * `exists` 由宿主注入(core 不吃 fs)。覆盖是最省事的做法,也是最容易让人
 * 丢东西的做法 —— 用户导入第二张同名壁纸时,第一张不该无声消失。
 */
export function nextAvailablePluginImportFileName(
  fileName: string,
  exists: (candidate: string) => boolean,
): string | null {
  if (!exists(fileName)) return fileName
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const suffix = dot > 0 ? fileName.slice(dot) : ''
  for (let index = 2; index <= MAX_IMPORT_NAME_ATTEMPTS; index += 1) {
    const candidate = `${stem}-${index}${suffix}`
    if (!exists(candidate)) return candidate
  }
  return null
}

export interface PluginFileImportCandidate {
  /** 用户选中的文件名(原名;判扩展名用)。 */
  name: string
  /** 字节数。 */
  size: number
  /** 该节点声明的 accept(已 resolve)。 */
  accept: readonly string[]
  /** 该节点声明的上限(已 clamp)。 */
  maxBytes: number
}

/**
 * 拷贝入口的闸 —— **扩展名 + 尺寸**,一句人话。
 *
 * 返回错误字符串 = 不拷、不发 action、宿主 toast 这句话、**不计熔断**:
 * 用户选错了一个文件不是插件的失败(与未声明权限的拒绝同规)。
 */
export function describePluginFileImportProblem(
  candidate: PluginFileImportCandidate,
): string | null {
  const extension = extensionOf(candidate.name)
  if (!extension || !candidate.accept.includes(extension)) {
    return `That file type isn't supported here — pick one of: ${candidate.accept.join(', ')}.`
  }
  if (!Number.isFinite(candidate.size) || candidate.size < 0) {
    return 'That file could not be read.'
  }
  if (candidate.size > candidate.maxBytes) {
    return `That file is too large (${formatBytes(candidate.size)}). `
      + `The limit here is ${formatBytes(candidate.maxBytes)}.`
  }
  return null
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
