/**
 * 声明式面板的**描述树协议**(R5)。
 *
 * 两条裁决落在这里:
 *  1. **静态存在感走 manifest**:面板的 id/label/icon 声明在
 *     `contributes.panels`(R2 已建),运行期的 `registerWorkspacePanel` 只绑定
 *     行为。宿主凭清单渲染入口,**不执行一行插件代码** —— 于是"启用了但加载失败"
 *     的插件入口仍在,并且能把失败说出来。停用的插件不贡献入口。
 *  2. **UI 永不执行插件代码**:插件交出的是一棵**纯数据**的描述树,渲染由宿主做。
 *     这是"窄腰"在 UI 侧的落地:插件能表达什么,与插件代码在哪执行,彻底解耦。
 *
 * 宪法第 2 条在这里是硬约束:**描述树禁函数成员**。按钮回调用 actionId 寻址,
 * 不是塞一个闭包 —— 闭包过不了 IPC,更过不了 H 线的进程边界。
 */
import { describePluginFilePickNodeProblem } from './file-pick.js'
import { describeNonSerializable } from './request-channel.js'
import { PLUGIN_UI_INVOKE_ACTION, PLUGIN_UI_RENDER_ACTION } from './ui-anchor.js'

/**
 * 协议版本。
 *
 * 描述树要活很多期(R5 只开这一小撮节点),留一个版本字段,宿主才能在将来
 * 同时认识新旧两棵树而不必猜。
 */
export const PLUGIN_PANEL_PROTOCOL_VERSION = 2

/** 请求通道上的 action 名 —— 宿主与插件的约定。 */
export const PLUGIN_PANEL_RENDER_ACTION = 'panel:render'
export const PLUGIN_PANEL_INVOKE_ACTION = 'panel:action'
/**
 * webview 面板的"render" —— **另一个名字,因为它是另一份契约**(C 期)。
 *
 * 描述树面板的 render 返回一棵会被宿主画出来的树;webview 面板的内容由
 * 插件静态文件提供,宿主要的只是**初始化数据**(一坨可序列化的 JSON,宿主
 * 不解释它,原样 postMessage 给 iframe)。同一个 action 名承载两份返回值语义,
 * 通道守卫就得反查"这个面板是哪一种"——那份反查一旦漂移,一棵没校验过的树
 * 或者一份被当成树拒收的初始化数据,两种事故都会出现。换个名字,守卫按前缀
 * 判定即可,不需要知道任何面板的形态。
 *
 * surface 折叠**不因此分叉**:`panel:init:<id>` 与 `panel:action:<id>` 仍折成
 * `panel:<id>`(policy.ts),熔断账与降级语义与描述树面板逐字相同。
 */
export const PLUGIN_PANEL_INIT_ACTION = 'panel:init'

export interface PluginPanelStackNode {
  type: 'stack'
  /** 纵向堆叠;gap 走宿主的间距刻度,不接受任意像素值。 */
  gap?: 'none' | 'small' | 'medium'
  children: PluginPanelNode[]
}

export interface PluginPanelListItem {
  id: string
  title: string
  subtitle?: string
  badge?: string
  /** 点击整行时派发的 action;省略则该行不可点。 */
  actionId?: string
  /** 随 action 一起回传的负载(必须 JSON-可序列化)。 */
  payload?: unknown
}

export interface PluginPanelListNode {
  type: 'list'
  title?: string
  items: PluginPanelListItem[]
  /** 列表为空时的替代内容。 */
  emptyText?: string
}

export interface PluginPanelMarkdownNode {
  type: 'markdown'
  /** 由宿主渲染 —— 插件给的是文本,不是 HTML。 */
  text: string
}

export interface PluginPanelButtonNode {
  type: 'button'
  label: string
  actionId: string
  payload?: unknown
  variant?: 'default' | 'danger'
  disabled?: boolean
}

export interface PluginPanelRowNode {
  type: 'row'
  children: PluginPanelNode[]
}

/** 表单:直接复用 R3 的控件描述,不发明第二套控件语言。 */
export interface PluginPanelFormNode {
  type: 'form'
  /** 提交按钮的 action;省略则表单只读。 */
  submitActionId?: string
  submitLabel?: string
  fields: PluginPanelFormField[]
}

export interface PluginPanelFormField {
  key: string
  label: string
  hint?: string
  control: 'switch' | 'text' | 'number' | 'select' | 'string-list'
    | 'textarea' | 'slider' | 'checkbox-group' | 'radio' | 'date' | 'color'
  /** control 为 select / checkbox-group / radio 时必填。 */
  options?: string[]
  /**
   * **仅初值**。
   *
   * 表单挂载之后编辑态活在宿主组件里,后续 render 返回的新树**不会**回写一个
   * 已挂载的表单 —— 否则用户打字打到一半会被一次后台刷新抹掉。要强制换值,
   * 让用户离开面板再回来,或者改用 button + 一次性 action。
   */
  value?: unknown
}

export interface PluginPanelEmptyStateNode {
  type: 'empty-state'
  title: string
  description?: string
  actionId?: string
  actionLabel?: string
}

// ── v2 节点(R5.x-b)────────────────────────────
// 每加一个原语,宿主渲染器、校验器、类型、测试四处都要动 —— 这是有意的成本:
// 描述树做"数据密集型、交互稀疏"的 UI,追不上的场景由 L3 webview 接住,
// 不是无限加原语直到够用(表达力文档 §1)。

export interface PluginPanelTableColumn {
  key: string
  label: string
  /** 列宽(px);省略由宿主均分。 */
  width?: number
}

export interface PluginPanelTableNode {
  type: 'table'
  columns: PluginPanelTableColumn[]
  /** 单元格是**纯文本/数字/布尔** —— 要在表格里放按钮,用 list 的 actionId。 */
  rows: Array<{ key: string; cells: Record<string, string | number | boolean | null> }>
  emptyText?: string
}

export interface PluginPanelTabsNode {
  type: 'tabs'
  /** body 是一棵子树 —— 嵌套深度照常计入 MAX_PANEL_DEPTH。 */
  items: Array<{ id: string; label: string; body: PluginPanelNode }>
}

export interface PluginPanelProgressNode {
  type: 'progress'
  /** 0–100;与 indeterminate 二选一(都不给 = 0%)。 */
  value?: number
  /** 不确定进度:宿主管线动画,插件只声明状态(描述树不表达动画)。 */
  indeterminate?: boolean
  label?: string
}

export interface PluginPanelSpinnerNode {
  type: 'spinner'
  label?: string
}

export interface PluginPanelBadgeNode {
  type: 'badge'
  text: string
  tone?: 'default' | 'accent' | 'danger' | 'success'
}

export interface PluginPanelImageNode {
  type: 'image'
  /**
   * 只允许 `data:` 与 `https:`(表达力文档 §2.4):http:/协议相对/其余 scheme
   * 会被校验器拒绝 —— 描述树是插件控制的数据,url 是插件伸向渲染进程的管子。
   */
  url: string
  alt: string
  maxWidth?: number
}

export interface PluginPanelLinkNode {
  type: 'link'
  text: string
  /** 只允许 `https:` / `mailto:`;与 actionId 二选一(都给时 actionId 优先)。 */
  url?: string
  /** 内联动作:点击派发 action 而不是打开链接。 */
  actionId?: string
  payload?: unknown
}

export interface PluginPanelCodeNode {
  type: 'code'
  text: string
  language?: string
}

export interface PluginPanelDividerNode {
  type: 'divider'
}

/**
 * 宿主托管的文件导入(B 期,用户壁纸)。
 *
 * **字节不过插件的手**:宿主画按钮、宿主拉原生对话框、宿主校验、宿主拷贝进
 * 这个插件的数据目录,onAction 只递一个**地址**
 * (`{ path: 'storage:imports/<name>', name, size }`)。插件拿不到用户磁盘上的
 * 路径,也拿不到文件内容 —— "让用户换张壁纸"因此不需要给插件开任何读文件的
 * 权限,判据与钳制全在 `file-pick.ts`。
 *
 * 取消选择 = **没有 action**(不是一条 `canceled: true` 的 action):插件不该
 * 因为用户按了 Esc 而被叫醒。
 */
export interface PluginPanelFilePickNode {
  type: 'file-pick'
  label: string
  /**
   * 可选扩展名,**只能是宿主白名单的子集**(收窄,不能加)。
   * 缺省 = 全白名单(`PLUGIN_FILE_PICK_EXTENSIONS`)。
   */
  accept?: string[]
  /** 单文件上限;宿主硬顶 10MB,声明更大按 10MB 算。 */
  maxBytes?: number
  actionId: string
}

/**
 * image 节点的 url 白名单(data: 内联小图 / https: 远程图 /
 * onething-plugin: 插件自有静态资源)。
 *
 * `onething-plugin:` 是 C 期放行的第三个 scheme:自定义协议只服务已装且启用的
 * 插件静态根内的白名单 MIME 文件,比 https 远程图**更**可控(内容不会随时间变)。
 * **只给 image,不给 link** —— 点开一个链接会导航,而这个 scheme 下的页面
 * 只该出现在 sandbox iframe 里。
 */
export const PLUGIN_IMAGE_URL_PATTERN = /^(?:data:|https:|onething-plugin:)/i
/** link 节点的 url 白名单。javascript: 之类在这里止步。 */
export const PLUGIN_LINK_URL_PATTERN = /^(?:https:|mailto:)/i

export type PluginPanelNode =
  | PluginPanelStackNode
  | PluginPanelRowNode
  | PluginPanelListNode
  | PluginPanelMarkdownNode
  | PluginPanelButtonNode
  | PluginPanelFormNode
  | PluginPanelEmptyStateNode
  | PluginPanelTableNode
  | PluginPanelTabsNode
  | PluginPanelProgressNode
  | PluginPanelSpinnerNode
  | PluginPanelBadgeNode
  | PluginPanelImageNode
  | PluginPanelLinkNode
  | PluginPanelCodeNode
  | PluginPanelDividerNode
  | PluginPanelFilePickNode

export interface PluginPanelTree {
  version: number
  /** 面板标题栏的补充文案(可选)。 */
  title?: string
  body: PluginPanelNode
  /**
   * 树级轮询(v2):宿主在块可见时按该周期重拉 render。
   * **下限 1000ms**(频率上限 1Hz)—— 更密的刷新请用 ctx.refresh() 事件驱动,
   * 不是把轮询拧成高频定时器。低于下限整树拒收。
   */
  refreshIntervalMs?: number
}

/**
 * action 的返回。
 *
 * `refresh` 让插件说"我改了状态,重新拉一次 render",不必自己再拼一棵树;
 * `tree` 让它直接给新树(省一次往返)。两者都不给 = 什么也不做。
 */
export interface PluginPanelActionResult {
  refresh?: boolean
  tree?: PluginPanelTree
  /** 一句给用户看的反馈(宿主用 toast 呈现)。 */
  notice?: string
}

const PANEL_NODE_TYPES = new Set([
  'stack', 'row', 'list', 'markdown', 'button', 'form', 'empty-state',
  // v2
  'table', 'tabs', 'progress', 'spinner', 'badge', 'image', 'link', 'code', 'divider',
  // B 期(用户壁纸):宿主托管的文件导入。词表 append-only,老宿主见到它
  // 会画那条 "Unsupported panel element" 占位 —— 而不是静默空白。
  'file-pick',
])

const FORM_CONTROLS = new Set([
  'switch', 'text', 'number', 'select', 'string-list',
  // v2(对齐 R3 设置页渲染能力)
  'textarea', 'slider', 'checkbox-group', 'radio', 'date', 'color',
])

/** 需要非空 options 的控件(选择集由插件给,宿主不发明选项)。 */
const FORM_CONTROLS_REQUIRING_OPTIONS = new Set(['select', 'checkbox-group', 'radio'])

/** 树级轮询的下限(频率上限 1Hz)。 */
export const PANEL_MIN_REFRESH_INTERVAL_MS = 1000

/** 描述树最大深度 —— 一棵能渲染的面板树不需要更深,深了多半是拼错了。 */
export const MAX_PANEL_DEPTH = 12

/**
 * 序列化校验在描述树上要扫多深。
 *
 * 不能用请求通道的默认 4 层:节点每嵌套一层要走两跳(children 数组 + 下标),
 * 12 层节点就是 24 跳,list 的 items / item 的 payload / button 的 payload 还要
 * 再几跳。用 4 层扫等于只查了最外面两层节点,`items[].payload` 里的函数一个也
 * 抓不到 —— "禁函数成员"那句承诺会变成半句话。描述树是小对象(要能渲染成一屏
 * UI),完整走一遍的代价可以忽略,不适用请求通道那个性能折中。
 */
export const PANEL_TREE_SCAN_DEPTH = MAX_PANEL_DEPTH * 2 + 8

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验一棵描述树。返回错误字符串,不抛 —— 调用方要把它变成面板的错误态,
 * 而不是让整个外壳崩掉。
 *
 * **禁函数成员**是这里的主命题(宪法第 2 条):塞进来的闭包在 IPC 上会被静默
 * 丢弃,插件那边看着"注册成功了",用户点下去毫无反应 —— 当场拒掉才说得清。
 */
export function validatePluginPanelTree(tree: unknown): string | null {
  if (!isPlainRecord(tree)) return 'panel tree must be an object'
  if (typeof tree.version !== 'number') return 'panel tree must carry a numeric "version"'
  if (tree.version > PLUGIN_PANEL_PROTOCOL_VERSION) {
    return `panel tree version ${tree.version} is newer than this host supports (${PLUGIN_PANEL_PROTOCOL_VERSION})`
  }
  if (tree.title !== undefined && typeof tree.title !== 'string') {
    return 'panel tree "title" must be a string'
  }
  if (tree.refreshIntervalMs !== undefined) {
    if (typeof tree.refreshIntervalMs !== 'number' || !Number.isFinite(tree.refreshIntervalMs)) {
      return 'panel tree "refreshIntervalMs" must be a finite number'
    }
    if (tree.refreshIntervalMs < PANEL_MIN_REFRESH_INTERVAL_MS) {
      return `panel tree "refreshIntervalMs" must be >= ${PANEL_MIN_REFRESH_INTERVAL_MS} (1Hz cap; use ctx.refresh() for denser updates)`
    }
  }

  // 整棵树过一次序列化校验:函数/Map/Set/类实例一律在这里止步。
  // 深度显式给足(见 PANEL_TREE_SCAN_DEPTH)—— 默认的 4 层扫不到 items 里的 payload。
  const problem = describeNonSerializable(tree, 'panel tree', 0, new WeakSet(), PANEL_TREE_SCAN_DEPTH)
  if (problem) return `panel tree must be pure data: ${problem}`

  return validateNode(tree.body, 'body', 0)
}

function validateNode(node: unknown, path: string, depth: number): string | null {
  if (depth > MAX_PANEL_DEPTH) return `${path}: panel tree is nested deeper than ${MAX_PANEL_DEPTH} levels`
  if (!isPlainRecord(node)) return `${path} must be an object`

  const type = node.type
  if (typeof type !== 'string' || !PANEL_NODE_TYPES.has(type)) {
    return `${path}.type must be one of ${[...PANEL_NODE_TYPES].join('/')}`
  }

  switch (type) {
    case 'stack':
    case 'row': {
      if (!Array.isArray(node.children)) return `${path}.children must be an array`
      for (const [index, child] of node.children.entries()) {
        const error = validateNode(child, `${path}.children[${index}]`, depth + 1)
        if (error) return error
      }
      return null
    }
    case 'list': {
      if (!Array.isArray(node.items)) return `${path}.items must be an array`
      for (const [index, item] of node.items.entries()) {
        if (!isPlainRecord(item)) return `${path}.items[${index}] must be an object`
        if (typeof item.id !== 'string' || !item.id) return `${path}.items[${index}].id must be a non-empty string`
        if (typeof item.title !== 'string') return `${path}.items[${index}].title must be a string`
      }
      return null
    }
    case 'markdown':
      return typeof node.text === 'string' ? null : `${path}.text must be a string`
    case 'button': {
      if (typeof node.label !== 'string' || !node.label) return `${path}.label must be a non-empty string`
      if (typeof node.actionId !== 'string' || !node.actionId) {
        // 按钮靠 actionId 寻址,不是靠闭包 —— 这条正是"禁函数成员"的实际用法。
        return `${path}.actionId must be a non-empty string (buttons address actions by id, not by callback)`
      }
      return null
    }
    case 'form': {
      if (!Array.isArray(node.fields)) return `${path}.fields must be an array`
      for (const [index, field] of node.fields.entries()) {
        if (!isPlainRecord(field)) return `${path}.fields[${index}] must be an object`
        if (typeof field.key !== 'string' || !field.key) return `${path}.fields[${index}].key must be a non-empty string`
        if (typeof field.label !== 'string') return `${path}.fields[${index}].label must be a string`
        if (typeof field.control !== 'string' || !FORM_CONTROLS.has(field.control)) {
          return `${path}.fields[${index}].control must be one of ${[...FORM_CONTROLS].join('/')}`
        }
        if (FORM_CONTROLS_REQUIRING_OPTIONS.has(field.control)
          && (!Array.isArray(field.options) || field.options.length === 0)) {
          return `${path}.fields[${index}] uses control "${field.control}" and needs a non-empty "options" array`
        }
      }
      return null
    }
    case 'empty-state':
      return typeof node.title === 'string' && node.title ? null : `${path}.title must be a non-empty string`
    case 'table': {
      if (!Array.isArray(node.columns) || node.columns.length === 0) {
        return `${path}.columns must be a non-empty array`
      }
      for (const [index, column] of node.columns.entries()) {
        if (!isPlainRecord(column)) return `${path}.columns[${index}] must be an object`
        if (typeof column.key !== 'string' || !column.key) return `${path}.columns[${index}].key must be a non-empty string`
        if (typeof column.label !== 'string') return `${path}.columns[${index}].label must be a string`
      }
      if (!Array.isArray(node.rows)) return `${path}.rows must be an array`
      for (const [index, row] of node.rows.entries()) {
        if (!isPlainRecord(row)) return `${path}.rows[${index}] must be an object`
        if (typeof row.key !== 'string' || !row.key) return `${path}.rows[${index}].key must be a non-empty string`
        if (!isPlainRecord(row.cells)) return `${path}.rows[${index}].cells must be an object`
        for (const [cellKey, cell] of Object.entries(row.cells)) {
          if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) {
            return `${path}.rows[${index}].cells.${cellKey} must be a string/number/boolean/null`
          }
        }
      }
      return null
    }
    case 'tabs': {
      if (!Array.isArray(node.items) || node.items.length === 0) {
        return `${path}.items must be a non-empty array`
      }
      for (const [index, item] of node.items.entries()) {
        if (!isPlainRecord(item)) return `${path}.items[${index}] must be an object`
        if (typeof item.id !== 'string' || !item.id) return `${path}.items[${index}].id must be a non-empty string`
        if (typeof item.label !== 'string') return `${path}.items[${index}].label must be a string`
        const error = validateNode(item.body, `${path}.items[${index}].body`, depth + 1)
        if (error) return error
      }
      return null
    }
    case 'progress': {
      if (node.value !== undefined) {
        if (typeof node.value !== 'number' || !Number.isFinite(node.value) || node.value < 0 || node.value > 100) {
          return `${path}.value must be a number between 0 and 100`
        }
      }
      if (node.indeterminate !== undefined && typeof node.indeterminate !== 'boolean') {
        return `${path}.indeterminate must be a boolean`
      }
      return null
    }
    case 'spinner':
      return node.label === undefined || typeof node.label === 'string' ? null : `${path}.label must be a string`
    case 'badge':
      return typeof node.text === 'string' && node.text ? null : `${path}.text must be a non-empty string`
    case 'image': {
      if (typeof node.url !== 'string' || !node.url) return `${path}.url must be a non-empty string`
      if (!PLUGIN_IMAGE_URL_PATTERN.test(node.url)) {
        return `${path}.url scheme is not allowed (image: data:/https:/onething-plugin: only)`
      }
      if (typeof node.alt !== 'string') return `${path}.alt must be a string`
      return null
    }
    case 'link': {
      if (typeof node.text !== 'string' || !node.text) return `${path}.text must be a non-empty string`
      if (node.url === undefined && node.actionId === undefined) {
        return `${path} needs a url or an actionId`
      }
      if (node.url !== undefined && (typeof node.url !== 'string' || !PLUGIN_LINK_URL_PATTERN.test(node.url))) {
        return `${path}.url scheme is not allowed (link: https:/mailto: only)`
      }
      return null
    }
    case 'code':
      return typeof node.text === 'string' ? null : `${path}.text must be a string`
    case 'divider':
      return null
    case 'file-pick':
      // 判据整条住 file-pick.ts —— 拷贝闸(宿主侧)要用同一批常量,
      // 分两处写就是"校验放行了、拷贝拒了"这种自相矛盾的来源。
      return describePluginFilePickNodeProblem(node, path)
    default:
      return `${path}.type "${type}" is not supported`
  }
}

export function validatePluginPanelActionResult(result: unknown): string | null {
  if (result === undefined || result === null) return null
  if (!isPlainRecord(result)) return 'panel action result must be an object'
  const problem = describeNonSerializable(result, 'panel action result', 0, new WeakSet(), PANEL_TREE_SCAN_DEPTH)
  if (problem) return `panel action result must be pure data: ${problem}`
  // notice 直接进 toast:传个对象过来,用户看到的是 "[object Object]"。
  if (result.notice !== undefined && typeof result.notice !== 'string') {
    return 'panel action result "notice" must be a string'
  }
  if (result.refresh !== undefined && typeof result.refresh !== 'boolean') {
    return 'panel action result "refresh" must be a boolean'
  }
  if (result.tree !== undefined) return validatePluginPanelTree(result.tree)
  return null
}

/**
 * `panel:*` 与 `ui:*` 请求结果的**唯一守卫**。
 *
 * 放在通道层而不是注册包装层:`panel:` / `ui:` 命名空间虽然已经对
 * registerRequestHandler 关上,但守卫只写在包装里的话,任何绕开包装的登记路径
 * (将来的第二个宿主、直接写 state.requestHandlers 的测试替身)都会把一棵没校验
 * 过的树喂给 renderer。通道是所有面板/锚点块结果的必经之路,钉在这里才是真的
 * 钉住。
 *
 * 锚点块与面板**同一套描述树协议**:块只是"小面板",校验不分叉。
 */
export function describePluginPanelResultProblem(action: string, result: unknown): string | null {
  // webview 面板的初始化数据不是树 —— 守卫退回"必须是纯数据"这一条(宪法第 2 条),
  // 不套描述树的形状。它照样过 PANEL_TREE_SCAN_DEPTH 的全树扫描:函数成员在这里
  // 一样止步(闭包过不了 postMessage 的结构化克隆,当场拒掉才说得清)。
  if (action.startsWith(`${PLUGIN_PANEL_INIT_ACTION}:`)) {
    if (result === undefined || result === null) return null
    const problem = describeNonSerializable(result, 'panel init data', 0, new WeakSet(), PANEL_TREE_SCAN_DEPTH)
    return problem ? `panel init data must be pure data: ${problem}` : null
  }
  if (action.startsWith(`${PLUGIN_PANEL_RENDER_ACTION}:`) || action.startsWith(`${PLUGIN_UI_RENDER_ACTION}:`)) {
    const problem = validatePluginPanelTree(result)
    return problem ? `panel render produced an invalid tree: ${problem}` : null
  }
  if (action.startsWith(`${PLUGIN_PANEL_INVOKE_ACTION}:`) || action.startsWith(`${PLUGIN_UI_INVOKE_ACTION}:`)) {
    const problem = validatePluginPanelActionResult(result)
    return problem ? `panel action produced an invalid result: ${problem}` : null
  }
  return null
}

/** `panel:` 是宿主保留的命名空间 —— 插件不能自己往里登记 handler。 */
export function isReservedPluginPanelAction(action: string): boolean {
  return action.startsWith('panel:')
}

// ── 插件侧注册面 ─────────────────────────────

export interface CorePluginPanelContext {
  /** 本次调用的地址(来自请求通道)。 */
  readonly requestId: string
  readonly abortSignal: AbortSignal
  /**
   * 让宿主重新拉一次 render。
   *
   * 这是插件**主动**刷新面板的唯一出口 —— 走既有的通知通道投递,
   * 不另开一条轨(§5.2 第 4 条:自定义事件不跨 IPC,R5 需要投递面时复用现成的)。
   *
   * 调用频率不必自律:宿主两端都合流(main 侧按 pluginId+panelId 短窗去重,
   * renderer 侧 trailing debounce + latest-wins),连打一百次也只重拉一次。
   */
  refresh(): void
}

export interface CorePluginPanelRegistration<TTree = PluginPanelTree, TResult = PluginPanelActionResult> {
  /** 必须与 manifest 的 contributes.panels 里某一项的 id 一致。 */
  id: string
  render(ctx: CorePluginPanelContext): TTree | Promise<TTree>
  onAction?(
    input: { actionId: string; payload?: unknown },
    ctx: CorePluginPanelContext,
  ): TResult | void | Promise<TResult | void>
}
