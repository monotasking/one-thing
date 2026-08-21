/**
 * 插件配置的 JSON Schema **子集**校验器(R3)。
 *
 * 手写、不引 ajv:core 是零依赖层,而为了校验一层扁平对象引一个完整 JSON Schema
 * 实现也不划算。
 *
 * **住在产品层而不是装配层**:它是纯函数(没有宿主依赖),而设置页需要同一份
 * 归约结果 —— renderer 可以吃 @onething/runtime/plugins,吃不到 @onething/backend。
 * 两边各写一份 schema→控件 的解析器,就是形状漂移的开始。
 *
 * **支持的子集 = 设置 UI 能渲染的控件集**。这两件事必须是同一份清单:能校验
 * 但渲染不出来 = 用户改不了;能渲染但校验不了 = 脏值进盘。所以子集清单写成
 * 常量,将来扩控件时同步扩这里("表达力不够就补原语",不是放宽校验)。
 *
 * 支持:boolean / string / number / integer / enum(string) / string 数组 /
 * 文件导入(`format: 'file-import'` 的 string);顶层单层 object。超出子集 →
 * 整个插件的配置区显示"schema 不受支持"并列出原因,不崩、不静默。
 */

import {
  clampPluginFilePickMaxBytes,
  deepFreezeCorePluginValue,
  describePluginDirectoryPickDeclarationProblem,
  describePluginFileImportDeclarationProblem,
  resolvePluginFilePickAccept,
  PLUGIN_SETTINGS_DIRECTORY_PICK_FORMAT,
  PLUGIN_SETTINGS_FILE_IMPORT_FORMAT,
} from '@onething/core/plugins'

/** 控件集 —— 与 PluginsSettingsTab 的渲染分支一一对应。 */
export const PLUGIN_CONFIG_CONTROLS = [
  'switch',
  'text',
  'number',
  'select',
  'string-list',
  'file-import',
  /**
   * F1 第二根:选一个**用户磁盘上的目录**。宿主画按钮 + 拉原生目录对话框,
   * 存的是绝对路径。只有同时声明了 `storage:external-root` 的插件才用得上它
   * (没声明的话 files 面照样拒绝,这个控件只是把一个字符串存进配置)。
   */
  'directory-pick',
] as const

export type PluginConfigControl = (typeof PLUGIN_CONFIG_CONTROLS)[number]

/**
 * 值的类型 —— **校验的唯一依据**。
 *
 * 与 control 严格分开:control 是纯呈现提示。让 coerce 跟着 control 走会击穿
 * manifest 自己的类型契约(`{type:'string'}` 配 `control:'switch'` 就会把 boolean
 * 落盘),而 schema 才是那份契约。
 */
export type PluginConfigValueType =
  | 'boolean'
  | 'string'
  | 'string-enum'
  | 'number'
  | 'integer'
  | 'string-array'

/** 类型 → 允许的呈现覆盖。不相容的覆盖进 unsupportedReasons,不静默降级。 */
const COMPATIBLE_CONTROLS: Record<PluginConfigValueType, readonly PluginConfigControl[]> = {
  boolean: ['switch'],
  // 纯 string 没有候选值,渲染成下拉是空下拉 —— 那是个永远存不进去的字段。
  // file-import 在这里合法是因为它存的**就是**一个字符串(`storage:` 地址):
  // 呈现覆盖不许改变值的类型契约,而这一条没有改。声明的正门仍是
  // `format: 'file-import'` —— 只有它能同时带上 accept / maxBytes。
  // directory-pick 与 file-import 同理:呈现覆盖不许改变值的类型契约,而它存的
  // 就是一个字符串(一条绝对路径)。声明的正门仍是 `format: 'directory-pick'`。
  string: ['text', 'file-import', 'directory-pick'],
  'string-enum': ['select', 'text'],
  number: ['number'],
  integer: ['number'],
  'string-array': ['string-list'],
}

const DEFAULT_CONTROL: Record<PluginConfigValueType, PluginConfigControl> = {
  boolean: 'switch',
  string: 'text',
  'string-enum': 'select',
  number: 'number',
  integer: 'number',
  'string-array': 'string-list',
}

/**
 * 原型污染面:这些键名走 `obj[key] = value` 会撞上原型 setter 被静默吞掉,
 * 或者更糟 —— 改掉 Object.prototype。schema 里出现它们一律判不支持。
 */
const FORBIDDEN_PROPERTY_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export interface PluginConfigField {
  key: string
  /** 校验依据。 */
  type: PluginConfigValueType
  /** 呈现提示(可被 contributes.settings.ui.control 覆盖);**不参与校验**。 */
  control: PluginConfigControl
  label: string
  hint?: string
  /**
   * 仅**呈现**语义:UI 在标签侧渲染一个必填标记。
   * 不做写入校验 —— 每个字段都有默认值,"缺失"这个状态不存在。
   */
  required: boolean
  /** select 的候选值。 */
  options?: string[]
  /** number 控件的边界(schema 的 minimum/maximum)。 */
  minimum?: number
  maximum?: number
  /** integer 时步进为 1。 */
  integer?: boolean
  /**
   * file-import 的**已裁决**声明:accept 已 ⊕ 宿主白名单,maxBytes 已被硬顶钳住。
   *
   * 存裁决后的值而不是 manifest 原文 —— 设置页拿它直接发起导入,也拿它给用户
   * 显示"这里能选什么、多大"。让 UI 自己再算一遍等于把裁决复制到第二个地方。
   */
  accept?: string[]
  maxBytes?: number
  /**
   * `format: 'directory-pick'` 的值语义标记(F1 第二根)。
   *
   * 是**校验依据**而不是呈现提示:带上它的 string 只接受绝对路径或空串。存一个
   * 相对路径进去,files 面解析出来的会是相对进程 CWD 的一个目录 —— 那是一个
   * 谁也说不清在哪的位置。存在性不在这里判(产品层不吃 fs),见 core 的
   * `PLUGIN_SETTINGS_DIRECTORY_PICK_FORMAT` 注释里的三层分工。
   */
  directoryPick?: boolean
  defaultValue: unknown
}

export type PluginConfigSchemaDescription =
  | { supported: true; title?: string; fields: PluginConfigField[] }
  | { supported: false; reasons: string[] }

export interface PluginConfigError {
  /** 出错的字段;缺省表示整体性错误。 */
  key?: string
  message: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * `Object.hasOwn` 的等价物(renderer 的 tsconfig lib 还没到 ES2022)。
 *
 * 用它而不是 `key in obj`:后者会把原型链上的东西(toString、constructor…)
 * 当成"用户存过的值"。
 */
function hasOwnKey(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, char => char.toUpperCase())
}

/**
 * 默认值必须**克隆**再交出去。
 *
 * 否则 string-list 字段拿到的是 manifest 里那个数组本体:插件
 * `api.settings.get().tags.push('x')` 会写穿常量,污染此后所有读取方直到重启。
 */
function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneDefault)
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDefault(item)]))
  }
  return value
}

/**
 * 深冻结:浅冻结只挡住顶层赋值,数组/对象成员照样可变。
 * 语义与 core 的 api.settings.get() 共用同一份实现,免得两处各冻各的。
 */
export function deepFreezePluginConfig<T>(value: T): T {
  return deepFreezeCorePluginValue(value)
}

interface FieldSchema {
  type?: unknown
  enum?: unknown
  items?: unknown
  default?: unknown
  description?: unknown
  title?: unknown
  minimum?: unknown
  maximum?: unknown
  /** JSON Schema 的扩展位;宿主只认 `file-import`,别的一律**忽略**(见 describeField)。 */
  format?: unknown
  accept?: unknown
  maxBytes?: unknown
}

/**
 * 把一条属性 schema 归约成一个字段。
 * 返回 string = 不支持的理由(会被聚合到配置区的说明里)。
 */
function describeField(
  key: string,
  raw: unknown,
  required: Set<string>,
  ui: Record<string, { label?: string; hint?: string; control?: string }>,
): PluginConfigField | string {
  if (FORBIDDEN_PROPERTY_NAMES.has(key)) {
    return `"${key}": property name is reserved (prototype pollution surface)`
  }
  if (!isPlainRecord(raw)) return `"${key}": property schema must be an object`
  const schema = raw as FieldSchema
  const hint = ui[key]?.hint ?? (typeof schema.description === 'string' ? schema.description : undefined)
  const label = ui[key]?.label ?? (typeof schema.title === 'string' ? schema.title : humanizeKey(key))
  const base = { key, label, hint, required: required.has(key) }

  /**
   * 文件导入(`format: 'file-import'`)—— 配置类的"选文件"住设置页的入口。
   *
   * 判在 enum/type 之前:它对 schema 的其余部分有约束(只能是 string,不能带
   * enum),先判掉才能给出一句说得清的理由,而不是让它掉进 string 分支后
   * 悄悄变成一个自由文本框(那正是"能力缺口把 UX 拽错位置"的翻版)。
   *
   * **未知的 format 一律忽略**:JSON Schema 规范就是这么说的(format 是注解),
   * 于是 `format: 'uri'` 退化成普通文本框而不是让整份 schema 变成不受支持。
   */
  if (schema.format === PLUGIN_SETTINGS_FILE_IMPORT_FORMAT) {
    if (schema.enum !== undefined) {
      return `"${key}": format "${PLUGIN_SETTINGS_FILE_IMPORT_FORMAT}" cannot be combined with enum`
    }
    if (schema.type !== undefined && schema.type !== 'string') {
      return `"${key}": format "${PLUGIN_SETTINGS_FILE_IMPORT_FORMAT}" is only supported on string properties `
        + `(the stored value is a "storage:" address)`
    }
    // accept / maxBytes 的判据与 file-pick 节点**同一份**(core)。
    const problem = describePluginFileImportDeclarationProblem(schema, `"${key}"`)
    if (problem) return problem
    if (schema.default !== undefined && typeof schema.default !== 'string') {
      return `"${key}": schema default is invalid — "${key}" must be a string`
    }
    return {
      ...base,
      type: 'string',
      control: 'file-import',
      accept: resolvePluginFilePickAccept(schema.accept),
      maxBytes: clampPluginFilePickMaxBytes(schema.maxBytes),
      defaultValue: cloneDefault(schema.default ?? ''),
    }
  }

  /**
   * 目录选择(`format: 'directory-pick'`)—— F1 第二根的入口。
   *
   * 与 file-import 同一个位置判(enum/type 之前)、同一个理由:它对 schema 其余
   * 部分有约束,先判掉才给得出一句说得清的理由,而不是掉进 string 分支变成一个
   * 自由文本框 —— 那正是"能力缺口把 UX 拽错位置"的翻版(用户手打一条路径,
   * 打错了没人拦)。
   */
  if (schema.format === PLUGIN_SETTINGS_DIRECTORY_PICK_FORMAT) {
    const problem = describePluginDirectoryPickDeclarationProblem(schema, `"${key}"`)
    if (problem) return problem
    return {
      ...base,
      type: 'string',
      control: 'directory-pick',
      directoryPick: true,
      defaultValue: '',
    }
  }

  // enum 优先于 type:一个带 enum 的 string 默认渲染成下拉,不是自由文本。
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      return `"${key}": enum must be a non-empty array`
    }
    if (schema.enum.some(option => typeof option !== 'string')) {
      return `"${key}": only string enums are supported`
    }
    if (schema.type !== undefined && schema.type !== 'string') {
      return `"${key}": enum is only supported on string properties`
    }
    const options = schema.enum as string[]
    return {
      ...base,
      type: 'string-enum',
      control: DEFAULT_CONTROL['string-enum'],
      options,
      defaultValue: cloneDefault(schema.default ?? options[0]),
    }
  }

  const type = schema.type
  if (typeof type !== 'string') {
    return `"${key}": type must be one of boolean/string/number/integer/array`
  }

  switch (type) {
    case 'boolean':
      return {
        ...base,
        type: 'boolean',
        control: DEFAULT_CONTROL.boolean,
        defaultValue: cloneDefault(schema.default ?? false),
      }
    case 'string':
      return {
        ...base,
        type: 'string',
        control: DEFAULT_CONTROL.string,
        defaultValue: cloneDefault(schema.default ?? ''),
      }
    case 'number':
    case 'integer':
      return {
        ...base,
        type,
        control: DEFAULT_CONTROL[type],
        integer: type === 'integer',
        minimum: typeof schema.minimum === 'number' ? schema.minimum : undefined,
        maximum: typeof schema.maximum === 'number' ? schema.maximum : undefined,
        defaultValue: cloneDefault(schema.default ?? (typeof schema.minimum === 'number' ? schema.minimum : 0)),
      }
    case 'array': {
      const items = schema.items
      if (!isPlainRecord(items) || (items as FieldSchema).type !== 'string') {
        return `"${key}": only arrays of strings are supported`
      }
      return {
        ...base,
        type: 'string-array',
        control: DEFAULT_CONTROL['string-array'],
        defaultValue: cloneDefault(schema.default ?? []),
      }
    }
    default:
      return `"${key}": unsupported type "${type}" (supported: boolean/string/number/integer/array-of-string)`
  }
}

/**
 * 把 manifest 的 schema 归约成宿主能渲染的字段表。
 *
 * 不支持时返回全部原因 —— 让插件作者一次看到所有要改的地方,而不是修一条报一条。
 */
export function describePluginConfigSchema(
  schema: unknown,
  options: {
    title?: string
    ui?: Record<string, { label?: string; hint?: string; control?: string }>
  } = {},
): PluginConfigSchemaDescription {
  if (!isPlainRecord(schema)) {
    return { supported: false, reasons: ['settings schema must be a JSON Schema object'] }
  }
  if (schema.type !== undefined && schema.type !== 'object') {
    return { supported: false, reasons: [`top-level schema must be type "object" (got "${String(schema.type)}")`] }
  }
  const properties = schema.properties
  if (properties !== undefined && !isPlainRecord(properties)) {
    return { supported: false, reasons: ['schema.properties must be an object'] }
  }
  if (!properties || Object.keys(properties).length === 0) {
    return { supported: true, title: options.title, fields: [] }
  }

  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [],
  )
  const ui = options.ui ?? {}
  const fields: PluginConfigField[] = []
  const reasons: string[] = []

  for (const key of Object.keys(properties)) {
    const described = describeField(key, properties[key], required, ui)
    if (typeof described === 'string') {
      reasons.push(described)
      continue
    }

    // manifest 自己的 default 也要过校验:`{type:'integer',minimum:1,default:0}`
    // 会让"坏值回退"回退到一个非法值,然后被写路径原样落盘 —— 永远循环。
    const defaultCheck = coerceField(described, described.defaultValue)
    if (defaultCheck.error) {
      reasons.push(`"${key}": schema default is invalid — ${defaultCheck.error}`)
      continue
    }

    const requestedControl = ui[key]?.control
    if (!requestedControl) {
      fields.push(described)
      continue
    }
    if (!(PLUGIN_CONFIG_CONTROLS as readonly string[]).includes(requestedControl)) {
      reasons.push(`"${key}": ui.control "${requestedControl}" is not one of ${PLUGIN_CONFIG_CONTROLS.join('/')}`)
      continue
    }
    const compatible = COMPATIBLE_CONTROLS[described.type]
    if (!compatible.includes(requestedControl as PluginConfigControl)) {
      // 呈现提示不许改变值的类型契约:schema 说 string 就必须存 string。
      reasons.push(
        `"${key}": ui.control "${requestedControl}" is not compatible with type "${described.type}" `
        + `(allowed: ${compatible.join('/')})`,
      )
      continue
    }
    const control = requestedControl as PluginConfigControl
    // `ui.control: 'file-import'` 走的是呈现覆盖这道侧门(正门是 format),
    // 它带不了 accept / maxBytes —— 那就把缺省裁决补齐,别让设置页拿到一个
    // 半张的声明再自己去猜宿主的白名单。
    // 同理的第二扇侧门:`ui.control: 'directory-pick'` 也必须把**值语义**带上,
    // 否则它只是长得像目录选择器、校验起来却是自由文本 —— 呈现与校验分家正是
    // 这一层要消灭的东西。
    if (control === 'directory-pick' && !described.directoryPick) {
      fields.push({ ...described, control, directoryPick: true, defaultValue: '' })
      continue
    }
    if (control === 'file-import' && described.accept === undefined) {
      fields.push({
        ...described,
        control,
        accept: resolvePluginFilePickAccept(undefined),
        maxBytes: clampPluginFilePickMaxBytes(undefined),
      })
      continue
    }
    fields.push({ ...described, control })
  }

  if (reasons.length > 0) return { supported: false, reasons }
  return { supported: true, title: options.title, fields }
}

export interface PluginConfigCoercion {
  config: Record<string, unknown>
  /** 存量坏值被回退成默认值的说明(读取路径 warn 用)。 */
  warnings: string[]
  /** 写入路径的硬错误:调用方给了这条 schema 不接受的值。 */
  errors: PluginConfigError[]
  /** 被剥掉的未知键。 */
  strippedKeys: string[]
}

/**
 * 绝对路径判定 —— **不引 node:path**。
 *
 * 这个文件被渲染层直接吃(设置页要同一份归约结果),而 `node:path` 在浏览器包里
 * 要么不存在要么是一个 posix 垫片:垫片会把 `C:\Users\x` 判成相对路径,于是同一份
 * 配置在主进程合法、在设置页报错。两个平台形态一共就两条规则,写在这里比拖一个
 * 会说谎的垫片进来划算。
 */
function isAbsolutePathLike(value: string): boolean {
  if (value.startsWith('/')) return true
  // Windows:盘符(`C:\` / `C:/`)与 UNC(`\\server\share`)。
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** 按 **schema type** 校验 —— control 只管长相,管不着值。 */
function coerceField(field: PluginConfigField, value: unknown): { value: unknown; error?: string } {
  switch (field.type) {
    case 'boolean':
      if (typeof value === 'boolean') return { value }
      return { value: cloneDefault(field.defaultValue), error: `"${field.key}" must be a boolean` }
    case 'string':
      if (typeof value !== 'string') {
        return { value: cloneDefault(field.defaultValue), error: `"${field.key}" must be a string` }
      }
      // directory-pick 的值语义(纯形状,不 stat):空串 = 还没选,合法;
      // 选了就必须是绝对路径 —— 相对路径会被解析成"相对进程 CWD",
      // 那是一个谁也说不清在哪的目录,而写进去的是用户的笔记。
      if (field.directoryPick && value !== '' && !isAbsolutePathLike(value)) {
        return {
          value: cloneDefault(field.defaultValue),
          error: `"${field.key}" must be an absolute folder path`,
        }
      }
      return { value }
    case 'string-enum':
      if (typeof value === 'string' && (field.options ?? []).includes(value)) return { value }
      return {
        value: cloneDefault(field.defaultValue),
        error: `"${field.key}" must be one of ${(field.options ?? []).join('/')}`,
      }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { value: cloneDefault(field.defaultValue), error: `"${field.key}" must be a finite number` }
      }
      if (field.type === 'integer' && !Number.isInteger(value)) {
        return { value: cloneDefault(field.defaultValue), error: `"${field.key}" must be an integer` }
      }
      if (field.minimum !== undefined && value < field.minimum) {
        return { value: cloneDefault(field.defaultValue), error: `"${field.key}" must be >= ${field.minimum}` }
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return { value: cloneDefault(field.defaultValue), error: `"${field.key}" must be <= ${field.maximum}` }
      }
      return { value }
    }
    case 'string-array':
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) return { value: [...value] }
      return { value: cloneDefault(field.defaultValue), error: `"${field.key}" must be an array of strings` }
    default:
      return { value: cloneDefault(field.defaultValue), error: `"${field.key}" has an unsupported type` }
  }
}

/**
 * 读取/写入共用的归一化。
 *
 * - 缺失的键 → 填**克隆过的**默认值(直接塞 manifest 里那个数组会被插件改穿);
 * - 非法的值 → 回退默认并记 warning(zod 的 .catch 语义)。存量坏值不该让
 *   插件拿不到配置,更不该发明一个迁移框架去"修"它;
 * - 未知的键 → 剥掉(schema 是唯一事实源,盘上多出来的东西不代表任何契约)。
 */
function deepEqualConfigValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqualConfigValue(item, b[index]))
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    return aKeys.length === bKeys.length
      && aKeys.every(key => hasOwnKey(b, key) && deepEqualConfigValue(a[key], b[key]))
  }
  return false
}

/**
 * 落盘前剥掉"与默认值相同"的键(VS Code 同语义)。
 *
 * 物化全字段的话,用户保存过一次之后,manifest 后续修改 default 对他永远不再
 * 生效 —— 他的盘上冻着一份当时的默认值快照。只存**偏离默认的部分**,未偏离的
 * 跟着 manifest 演进;读路径本来就会填默认,所以有效配置一模一样。
 */
export function stripPluginConfigDefaults(
  fields: PluginConfigField[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const stored: Record<string, unknown> = {}
  for (const field of fields) {
    if (!hasOwnKey(config, field.key)) continue
    if (deepEqualConfigValue(config[field.key], field.defaultValue)) continue
    stored[field.key] = config[field.key]
  }
  return stored
}

export function coercePluginConfig(
  fields: PluginConfigField[],
  stored: unknown,
): PluginConfigCoercion {
  const input = isPlainRecord(stored) ? stored : {}
  const config: Record<string, unknown> = {}
  const warnings: string[] = []
  const errors: PluginConfigError[] = []

  for (const field of fields) {
    // hasOwn 而不是 `in`:后者会把原型链上的东西(toString、constructor…)
    // 当成"用户存过的值"。
    if (!hasOwnKey(input, field.key)) {
      config[field.key] = cloneDefault(field.defaultValue)
      continue
    }
    const { value, error } = coerceField(field, input[field.key])
    config[field.key] = value
    if (error) {
      warnings.push(`${error}; falling back to the default`)
      errors.push({ key: field.key, message: error })
    }
  }

  const known = new Set(fields.map(field => field.key))
  const strippedKeys = Object.keys(input).filter(key => !known.has(key))

  return { config, warnings, errors, strippedKeys }
}
