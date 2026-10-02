import fs from 'fs'
import { toLogger, type CompatLogger } from '../logging/index.js'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { writeJsonFile } from '../storage/json-file.js'
import { getCoreLogger } from '../logging/index.js'

const log = getCoreLogger('core.plugins')

import type {
  CorePluginDefinition,
  PersistedPluginHealth,
  PluginManifest,
  PluginSettings,
  PluginSource,
} from './types.js'
import { PLUGIN_SKIN_MAX_ENTRIES, PLUGIN_THEME_OVERRIDE_MAX_ENTRIES } from './theme-contribution.js'

export const DEFAULT_PLUGIN_ENTRY = 'plugin-entry.js'

export interface CorePluginLoaderPathOptions {
  homeDir?: string
  storePath?: string
  defaultStoreDirName?: string
}

export interface CoreBuiltinPluginSpec<TEntry = unknown> {
  id: string
  manifest: PluginManifest
  entry: TEntry
  enabled: boolean
}

export function createBuiltinPluginDefinitions<TEntry = unknown>(
  specs: Array<CoreBuiltinPluginSpec<TEntry>>,
): Array<CorePluginDefinition<TEntry>> {
  return specs.map(spec => ({
    id: spec.id,
    source: 'builtin',
    manifest: spec.manifest,
    dirPath: `builtin://${spec.id}`,
    entryPath: `builtin://${spec.id}/${DEFAULT_PLUGIN_ENTRY}`,
    entry: spec.entry,
    enabled: spec.enabled,
  }))
}

export function getCorePluginStorePath(options: CorePluginLoaderPathOptions = {}): string {
  return options.storePath || path.join(options.homeDir || os.homedir(), options.defaultStoreDirName ?? '.headless-core')
}

export function getCorePluginsDir(options: CorePluginLoaderPathOptions = {}): string {
  return path.join(getCorePluginStorePath(options), 'plugins')
}

export function getCorePluginSettingsPath(options: CorePluginLoaderPathOptions = {}): string {
  return path.join(getCorePluginStorePath(options), 'plugin-settings.json')
}

/**
 * 轻通道的专用目录:`<store>/plugins-dev/`。
 *
 * **与 `plugins/`(npm 账本唯一,2026-08-09 A 期)物理分离** —— 单文件脚本只从这里
 * 扫,`plugins/` 的账本扫描一字不动。名字带 `-dev` 后缀,意在"给自己加个仪表"的
 * 本地脚本,不是市场分发的正式插件。
 */
export function getCoreLocalPluginsDir(options: CorePluginLoaderPathOptions = {}): string {
  return path.join(getCorePluginStorePath(options), 'plugins-dev')
}

export function ensureCorePluginsDir(
  pluginsDir: string,
  injectedLogger?: CorePluginLoaderLogger,
): void {
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true })
    toLogger(injectedLogger).debug(`[PluginLoader] Created plugins directory: ${pluginsDir}`)
  }
}

/**
 * 读 plugin-settings。
 *
 * parse 失败时**把坏文件挪走再返回空**,而不是直接拿 `{}` 当结果继续用:
 * 这个文件现在装着启停位、熔断原因和用户手工配的插件配置(R3),而下一次任意
 * 写入(比如熔断落一条 health)都会以读到的东西为基底整份重写 —— 让 `{}` 成为
 * 基底,等于一次半截 JSON 就把用户的全部配置静默蒸发掉。备份成
 * `.corrupt-<时间戳>` 至少留得下现场。
 */
export function readPluginSettingsFile(settingsPath: string): PluginSettings {
  if (!fs.existsSync(settingsPath)) return {}

  let raw: string
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8')
  } catch (error) {
    log.error('plugin settings read failed', { settingsPath }, error)
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('plugin settings must be a JSON object')
    }
    return parsed as PluginSettings
  } catch (error) {
    const backupPath = `${settingsPath}.corrupt-${Date.now()}`
    try {
      fs.renameSync(settingsPath, backupPath)
      log.error('plugin settings unreadable, quarantined', { settingsPath, backupPath }, error)
    } catch (renameError) {
      log.error('plugin settings quarantine failed', { settingsPath }, renameError)
    }
    return {}
  }
}

/**
 * 写 plugin-settings —— 走原子写(tmp + rename)。
 *
 * 裸 writeFileSync 在写到一半掉电/被杀时留下半截 JSON;配上上面那个"读不出来
 * 就当空"的旧行为,就是用户配置静默蒸发的完整配方。
 */
export function writePluginSettingsFile(settingsPath: string, settings: PluginSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  writeJsonFile(settingsPath, settings)
}

export function getPluginEnabledFromSettings(
  settings: PluginSettings,
  pluginId: string,
  fallback = true,
): boolean {
  return settings.enabled?.[pluginId] ?? fallback
}

export function setPluginEnabledInSettings(
  settings: PluginSettings,
  pluginId: string,
  enabled: boolean,
): PluginSettings {
  return {
    ...settings,
    enabled: {
      ...settings.enabled,
      [pluginId]: enabled,
    },
  }
}

export function getPluginHealthFromSettings(
  settings: PluginSettings,
  pluginId: string,
): PersistedPluginHealth | undefined {
  return settings.health?.[pluginId]
}

export function listPluginHealthFromSettings(
  settings: PluginSettings,
): Array<{ pluginId: string; health: PersistedPluginHealth }> {
  return Object.entries(settings.health ?? {}).map(([pluginId, health]) => ({ pluginId, health }))
}

export function setPluginHealthInSettings(
  settings: PluginSettings,
  pluginId: string,
  health: PersistedPluginHealth | null,
): PluginSettings {
  const next = { ...settings.health }
  if (health) next[pluginId] = health
  else delete next[pluginId]

  if (Object.keys(next).length === 0) {
    const { health: _dropped, ...rest } = settings
    return rest
  }
  return { ...settings, health: next }
}

export function getPluginConfigFromSettings(
  settings: PluginSettings,
  pluginId: string,
): Record<string, unknown> {
  return settings.config?.[pluginId] ?? {}
}

export function setPluginConfigInSettings(
  settings: PluginSettings,
  pluginId: string,
  config: Record<string, unknown> | null,
): PluginSettings {
  const next = { ...settings.config }
  if (config && Object.keys(config).length > 0) next[pluginId] = config
  else delete next[pluginId]

  if (Object.keys(next).length === 0) {
    const { config: _dropped, ...rest } = settings
    return rest
  }
  return { ...settings, config: next }
}

export interface CorePluginSettingsStorageAdapters {
  readSettings(): PluginSettings
  writeSettings(settings: PluginSettings): void
}

export function getPluginEnabledWithAdapters(
  pluginId: string,
  fallback: boolean,
  adapters: Pick<CorePluginSettingsStorageAdapters, 'readSettings'>,
): boolean {
  return getPluginEnabledFromSettings(adapters.readSettings(), pluginId, fallback)
}

export function setPluginEnabledWithAdapters(
  pluginId: string,
  enabled: boolean,
  adapters: CorePluginSettingsStorageAdapters,
): PluginSettings {
  const nextSettings = setPluginEnabledInSettings(adapters.readSettings(), pluginId, enabled)
  adapters.writeSettings(nextSettings)
  return nextSettings
}

/**
 * 轻量 semver 比较(不引依赖 —— core 是零依赖层)。
 *
 * 只认 `major.minor.patch` 前缀,预发布后缀(`-beta.1`)被忽略:minAppVersion
 * 想表达的是"宿主至少要有这个能力面",预发布次序不值得为它引一个依赖。
 * 返回 <0 / 0 / >0。
 */
export function compareCoreSemver(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const core = String(value).trim().replace(/^[vV]/, '').split(/[-+]/)[0]
    const parts = core.split('.').map(part => Number.parseInt(part, 10))
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * 宿主版本未知(没配)时一律放行 —— 拿不到版本不是拒绝加载的理由。
 *
 * 但那也意味着这道闸此刻是**关着的**:插件声明了 minAppVersion 而我们无从比对。
 * 静默放行会让人以为闸在工作,所以吼一声。
 */
export function checkPluginMinAppVersion(
  manifest: Pick<PluginManifest, 'minAppVersion'>,
  appVersion?: string,
  injectedLogger?: CorePluginLoaderLogger,
): string | null {
  const required = manifest.minAppVersion?.trim()
  if (!required) return null
  if (!appVersion) {
    toLogger(injectedLogger).warn(
      `[PluginLoader] Plugin declares minAppVersion "${required}" but the host version is not configured; `
      + 'the version gate is inactive (call configurePluginAppVersion at boot).',
    )
    return null
  }
  if (compareCoreSemver(appVersion, required) >= 0) return null
  return `requires app >= ${required} (current ${appVersion})`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const JSON_SCHEMA_TYPES = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
])

/**
 * settings.schema 的最低形状校验。
 *
 * 不做完整的 JSON Schema 元校验(那要引依赖,core 是零依赖层),但要挡住
 * `{"type": 42}` 这种一眼就坏的东西 —— R3 的设置页会拿它去渲染表单,
 * 到那时候才炸就是在错误的层报错。
 */
function validateSettingsSchemaShape(schema: Record<string, unknown>): string | null {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    for (const type of types) {
      if (typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) {
        return `contributes.settings.schema.type must be one of ${[...JSON_SCHEMA_TYPES].join('/')}`
      }
    }
  }

  if (schema.properties !== undefined) {
    if (!isPlainRecord(schema.properties)) {
      return 'contributes.settings.schema.properties must be an object'
    }
    for (const [key, value] of Object.entries(schema.properties)) {
      if (!isPlainRecord(value)) {
        return `contributes.settings.schema.properties.${key} must be an object`
      }
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some(item => typeof item !== 'string')) {
      return 'contributes.settings.schema.required must be an array of strings'
    }
  }

  return null
}

/**
 * contributes 段校验。
 *
 * 返回错误字符串而不是抛 —— 非法声明让插件进 error 态,不能把整轮扫描带崩
 * (一个手写坏了的 plugin.json 不该让其余插件全部消失)。
 */
export function validatePluginContributes(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (!isPlainRecord(raw)) return 'contributes must be an object'

  const commands = raw.commands
  if (commands !== undefined) {
    if (!Array.isArray(commands)) return 'contributes.commands must be an array'
    for (const [index, command] of commands.entries()) {
      if (!isPlainRecord(command) || typeof command.name !== 'string' || !command.name.trim()) {
        return `contributes.commands[${index}].name must be a non-empty string`
      }
    }
  }

  const panels = raw.panels
  if (panels !== undefined) {
    if (!Array.isArray(panels)) return 'contributes.panels must be an array'
    for (const [index, panel] of panels.entries()) {
      if (!isPlainRecord(panel) || typeof panel.id !== 'string' || !panel.id.trim()) {
        return `contributes.panels[${index}].id must be a non-empty string`
      }
      if (typeof panel.label !== 'string' || !panel.label.trim()) {
        return `contributes.panels[${index}].label must be a non-empty string`
      }
      // view/entry(C 期)只校验**形状**(必须是字符串):内容非法 =
      // 丢弃该 panel 并在投影里标记(与未知锚点同规),不是加载期错误 ——
      // 拒载的插件根本不进清单,那条"这个面板为什么没出现"就说不出来了。
      if (panel.view !== undefined && typeof panel.view !== 'string') {
        return `contributes.panels[${index}].view must be a string`
      }
      if (panel.entry !== undefined && typeof panel.entry !== 'string') {
        return `contributes.panels[${index}].entry must be a string`
      }
      // placements(H1)只校验**形状**(字符串数组):面板可以出现在哪些宿主表面
      // (工作区面板 / 右侧工作台 tab)。缺省 = ['workspace'](现状,只在主工作区)。
      // append-only:老面板没有这个字段,行为零变化。成员枚举不在 loader 判 ——
      // 未知 placement 值在旧宿主上不能被拒载(与未知锚点降级同规),投影层过滤。
      if (panel.placements !== undefined) {
        if (!Array.isArray(panel.placements)) {
          return `contributes.panels[${index}].placements must be an array`
        }
        if (panel.placements.some(item => typeof item !== 'string')) {
          return `contributes.panels[${index}].placements must be an array of strings`
        }
      }
    }
  }

  // 静态根同上:形状在这里,内容判据在 describePluginWebviewPanelProblem
  // (根非法 → 该插件的全部 webview 面板被丢弃并标出原因)。
  if (raw.webviewRoot !== undefined && typeof raw.webviewRoot !== 'string') {
    return 'contributes.webviewRoot must be a string'
  }

  // uiSlots(R5.x)只校验**形状**。锚点是否存在于宿主清单不在这里判:
  // 未知锚点 = 丢弃该条并标记 unsupported(投影层的职责),不是加载期错误 ——
  // 多宿主与版本偏斜下"宿主不认识这个锚点"不是代码错误。
  const uiSlots = raw.uiSlots
  if (uiSlots !== undefined) {
    if (!Array.isArray(uiSlots)) return 'contributes.uiSlots must be an array'
    for (const [index, slot] of uiSlots.entries()) {
      if (!isPlainRecord(slot) || typeof slot.anchor !== 'string' || !slot.anchor.trim()) {
        return `contributes.uiSlots[${index}].anchor must be a non-empty string`
      }
      if (typeof slot.id !== 'string' || !slot.id.trim()) {
        return `contributes.uiSlots[${index}].id must be a non-empty string`
      }
      if (typeof slot.label !== 'string' || !slot.label.trim()) {
        return `contributes.uiSlots[${index}].label must be a non-empty string`
      }
      // lifetime 只校验形状(字符串):枚举成员不在 loader 判 —— 未来新生命期
      // 值在旧宿主上不能被拒载(与未知锚点降级同规),闸门读 === 'persistent',
      // 未知值天然是非持久。
      if (slot.lifetime !== undefined && typeof slot.lifetime !== 'string') {
        return `contributes.uiSlots[${index}].lifetime must be a string`
      }
      // drawer(F 期)同样只校验**形状**(必须是布尔)。"这个锚点开不开抽屉"
      // 不在这里判:锚点没开抽屉能力 = 该字段被忽略并在投影里标记,不拒载 ——
      // 与未知锚点同规(旧宿主/别的宿主没有抽屉不是插件的错)。
      if (slot.drawer !== undefined && typeof slot.drawer !== 'boolean') {
        return `contributes.uiSlots[${index}].drawer must be a boolean`
      }
      // side(I 期)同样只校验**形状**(必须是字符串)。"这个锚点分不分侧"
      // 与"这个字符串是不是 left/right"都不在这里判:前者是宿主能力(不分侧
      // 的锚点上忽略并标记),后者留给投影层归一到缺省侧 —— 未来第三个侧位
      // 值在旧宿主上不能拒载,与未知锚点降级同规。
      if (slot.side !== undefined && typeof slot.side !== 'string') {
        return `contributes.uiSlots[${index}].side must be a string`
      }
      // 锚点块**不开** webview(C 期拍板,D 期原样适用于 trigger):
      // composer.above 是 32px 单行,chat.status-bar 24px —— 往里塞一个 iframe
      // 没有正经场景;trigger 的弹层同样只画描述树(§9.1 expression 轴:
      // webview 只允许出现在 singleton 的 block,今天 = 仅工作区面板),而"能塞"
      // 会立刻变成"每个插件都塞"。这里当场拒载(不是降级):作者在 manifest 里
      // 指名道姓要一个宿主永远不会给的能力,没有版本偏斜的歧义可容 ——
      // 与未知**锚点**降级的区别正在于此(那个是"这个宿主还没有",
      // 这个是"任何宿主都不会有")。
      if (slot.view !== undefined) {
        return `contributes.uiSlots[${index}].view is not supported — anchors always render descriptor trees; `
          + 'webview is a panel-only form (contributes.panels[].view)'
      }
    }
  }

  // theme(B 期)只校验**形状**:是不是对象、值是不是字符串、条目数是否越界。
  // 键是否属于主题 token 表、值是否是合法颜色**不在这里判** —— 前者 core 吃不到
  // 主题模块,后者按 §6.1 是"丢弃该条目并在投影里标记"的降级,不是拒载。
  const theme = raw.theme
  if (theme !== undefined) {
    if (!isPlainRecord(theme)) return 'contributes.theme must be an object'
    const overrides = theme.overrides
    // G 期起 overrides 可缺省:`contributes.theme` 也可能只带 background。
    if (overrides !== undefined) {
      if (!isPlainRecord(overrides)) return 'contributes.theme.overrides must be an object'
      const entries = Object.entries(overrides)
      if (entries.length > PLUGIN_THEME_OVERRIDE_MAX_ENTRIES) {
        return `contributes.theme.overrides must not exceed ${PLUGIN_THEME_OVERRIDE_MAX_ENTRIES} entries`
      }
      for (const [token, value] of entries) {
        if (!token.trim()) return 'contributes.theme.overrides keys must be non-empty strings'
        if (typeof value !== 'string') {
          return `contributes.theme.overrides.${token} must be a string`
        }
      }
    }
    // skin(H3)同规:只校验**形状**。旋钮名是否开放、档位是否在枚举内**不在这里
    // 判** —— 旋钮表住在主题层(core 吃不到),而非法值按 §6.1 是"丢弃该键并在
    // 投影里标记"的降级,不是拒载。
    const skin = theme.skin
    if (skin !== undefined) {
      if (!isPlainRecord(skin)) return 'contributes.theme.skin must be an object'
      const skinEntries = Object.entries(skin)
      if (skinEntries.length > PLUGIN_SKIN_MAX_ENTRIES) {
        return `contributes.theme.skin must not exceed ${PLUGIN_SKIN_MAX_ENTRIES} entries`
      }
      for (const [knob, tier] of skinEntries) {
        if (!knob.trim()) return 'contributes.theme.skin keys must be non-empty strings'
        if (typeof tier !== 'string') {
          return `contributes.theme.skin.${knob} must be a string`
        }
      }
    }
    // `contributes.theme.background`(G 期,L2.5)**不在这里判**:路径穿越 /
    // 坏扩展名 / 越界数值全部是"丢弃 background 并在投影里标记"的降级,
    // 不是拒载(与未知锚点、token 覆盖同规)。判据在 core 的 background.ts,
    // 裁决在清单投影里 —— 拒载的插件根本不进清单,理由就没地方说。
  }

  const settings = raw.settings
  if (settings !== undefined) {
    if (!isPlainRecord(settings)) return 'contributes.settings must be an object'
    if (settings.schema !== undefined) {
      if (!isPlainRecord(settings.schema)) {
        return 'contributes.settings.schema must be a JSON Schema object'
      }
      const schemaError = validateSettingsSchemaShape(settings.schema)
      if (schemaError) return schemaError
    }
    if (settings.ui !== undefined) {
      if (!isPlainRecord(settings.ui)) return 'contributes.settings.ui must be an object'
      for (const [key, hint] of Object.entries(settings.ui)) {
        if (!isPlainRecord(hint)) return `contributes.settings.ui.${key} must be an object`
        for (const field of ['label', 'hint', 'control'] as const) {
          if (hint[field] !== undefined && typeof hint[field] !== 'string') {
            return `contributes.settings.ui.${key}.${field} must be a string`
          }
        }
      }
    }
  }

  const permissions = raw.permissions
  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || permissions.some(item => typeof item !== 'string')) {
      return 'contributes.permissions must be an array of strings'
    }
  }

  const activation = raw.activation
  if (activation !== undefined) {
    if (!isPlainRecord(activation)) return 'contributes.activation must be an object'
    if (activation.events !== undefined
      && (!Array.isArray(activation.events) || activation.events.some(item => typeof item !== 'string'))) {
      return 'contributes.activation.events must be an array of strings'
    }
  }

  return null
}

export function parsePluginDirectory<TEntry = unknown>(input: {
  id: string
  dirPath: string
  enabled: boolean
  source?: PluginSource
  defaultEntry?: string
  /** 宿主版本;用于 minAppVersion 判定。省略 = 跳过判定。 */
  appVersion?: string
}): CorePluginDefinition<TEntry> | null {
  const manifestPath = path.join(input.dirPath, 'plugin.json')
  let manifest: CorePluginDefinition<TEntry>['manifest'] | null = null

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (error) {
      log.error('invalid plugin.json', { pluginId: input.id, dirPath: input.dirPath }, error)
    }
  }

  if (!manifest) {
    manifest = { name: input.id, version: '0.0.0' }
  }

  const entryFile = manifest.entry || input.defaultEntry || DEFAULT_PLUGIN_ENTRY
  const entryPath = path.join(input.dirPath, entryFile)

  if (!fs.existsSync(entryPath)) {
    log.warn('plugin entry file missing', { pluginId: input.id, entryPath })
    return null
  }

  // 声明层的两道闸,都在扫描期判完:非法 contributes 与宿主版本不够。
  // 判定结果只标记,不抛 —— 一个坏 plugin.json 不该让整轮扫描消失。
  const contributesError = validatePluginContributes((manifest as { contributes?: unknown }).contributes)
  if (contributesError) {
    log.warn('plugin contributes invalid', { pluginId: input.id, reason: contributesError })
    manifest = { ...manifest, contributes: undefined }
  }
  const versionError = checkPluginMinAppVersion(manifest, input.appVersion)

  return {
    id: input.id,
    source: input.source,
    manifest,
    dirPath: input.dirPath,
    entryPath,
    enabled: input.enabled,
    loadBlockedReason: versionError
      ?? (contributesError ? `invalid plugin.json: ${contributesError}` : undefined),
  }
}

/**
 * 一轮扫描的**可信度**。
 *
 * `existsSync`/`readdirSync` 失败与"目录里确实没有插件"在返回值上长得一模一样,
 * 而这两件事的下游后果天差地别:后者只是没插件,前者会让孤儿归档把
 * plugin-data 下的所有目录当成无主数据搬走。所以扫描必须自己说清楚
 * "我这轮读得可不可信"。
 */
export interface CorePluginScanTrust {
  trusted: boolean
  reason?: string
  /** 源目录下实际存在的条目名(含 symlink)—— 所有权判定用它,不是用能否加载。 */
  presentEntryNames: string[]
}

export function scanPluginSourceEntries(pluginsDir: string): CorePluginScanTrust {
  let stat: fs.Stats
  try {
    stat = fs.statSync(pluginsDir)
  } catch (error) {
    const code = (error as { code?: string }).code
    // ENOENT 是"还没建过插件目录",是可信的空;其余(EACCES/EIO/…)不可信。
    if (code === 'ENOENT') return { trusted: true, presentEntryNames: [] }
    return { trusted: false, reason: `cannot stat ${pluginsDir} (${code ?? 'unknown'})`, presentEntryNames: [] }
  }
  if (!stat.isDirectory()) {
    return { trusted: false, reason: `${pluginsDir} is not a directory`, presentEntryNames: [] }
  }

  try {
    return {
      trusted: true,
      presentEntryNames: fs.readdirSync(pluginsDir, { withFileTypes: true })
        // **含 symlink**:dirent.isDirectory() 对符号链接是 false,而
        // `ln -s sample-plugins/x ~/.onething/plugins/x` 正是 README 教的装法 ——
        // 漏掉它等于每轮 refresh 都把它的数据判成孤儿。
        .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .map(entry => entry.name),
    }
  } catch (error) {
    const code = (error as { code?: string }).code
    return { trusted: false, reason: `cannot read ${pluginsDir} (${code ?? 'unknown'})`, presentEntryNames: [] }
  }
}

export function scanPluginDirectories<TEntry = unknown>(input: {
  pluginsDir: string
  seenIds?: Set<string>
  getEnabled: (pluginId: string) => boolean
  appVersion?: string
}): CorePluginDefinition<TEntry>[] {
  let entries: fs.Dirent[]
  try {
    if (!fs.statSync(input.pluginsDir).isDirectory()) return []
    entries = fs.readdirSync(input.pluginsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const plugins: CorePluginDefinition<TEntry>[] = []
  const seen = input.seenIds ?? new Set<string>()

  for (const entry of entries) {
    // symlink 装法的目录 dirent.isDirectory() 为 false —— 用 statSync 跟随链接判。
    if (!entry.isDirectory()) {
      if (!entry.isSymbolicLink()) continue
      try {
        if (!fs.statSync(path.join(input.pluginsDir, entry.name)).isDirectory()) continue
      } catch {
        continue
      }
    }
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (seen.has(entry.name)) {
      log.warn('user plugin skipped, builtin id collision', { entry: entry.name })
      continue
    }
    const dirPath = path.join(input.pluginsDir, entry.name)
    const definition = parsePluginDirectory<TEntry>({
      id: entry.name,
      dirPath,
      enabled: input.getEnabled(entry.name),
      source: 'user',
      appVersion: input.appVersion,
    })
    if (definition) {
      plugins.push(definition)
      seen.add(definition.id)
    }
  }

  return plugins
}

/** 扫描语义:directory = 遍历插件根(现状);npm-ledger = 以 plugins/package.json 的 dependencies 为账。 */
export type CorePluginScanMode = 'directory' | 'npm-ledger'

/**
 * pluginId = 包名去 scope(单 scope):`@org/foo` → `foo`,无 scope 原样。
 *
 * 同 id 冲突(两个 scope 装了同名包)由扫描方拒绝后到者 —— 这里只做
 * 机械去前缀,不做仲裁。
 */
export function unscopedPluginIdFromPackageName(name: string): string {
  const match = /^@[^/]+\/(.+)$/.exec(name)
  return match ? match[1] : name
}

/**
 * 一轮账读的**可信度**。
 *
 * 与 CorePluginScanTrust 同理:`plugins/package.json` 读失败/坏 JSON 与
 * “确实没装任何 npm 插件”必须区分 —— 拿空账当真,下游会把全部 npm 插件
 * 的家目录判成孤儿。读失败 = 空账 + warn + 什么都不删。
 */
export interface CorePluginLedgerRead {
  trusted: boolean
  reason?: string
  /** dependencies 的 [包名, spec] 对;只有值为 string 的条目才算账。 */
  entries: Array<{ name: string; spec: string }>
}

export function readPluginLedger(pluginsDir: string): CorePluginLedgerRead {
  const ledgerPath = path.join(pluginsDir, 'package.json')
  let raw: string
  try {
    raw = fs.readFileSync(ledgerPath, 'utf-8')
  } catch (error) {
    const code = (error as { code?: string }).code
    // ENOENT = 还没初始化过脚手架,是可信的空账。
    if (code === 'ENOENT') return { trusted: true, entries: [] }
    return { trusted: false, reason: `cannot read plugin ledger ${ledgerPath} (${code ?? 'unknown'})`, entries: [] }
  }

  try {
    const pkg = JSON.parse(raw) as { dependencies?: unknown }
    const deps = pkg.dependencies
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
      return { trusted: true, entries: [] }
    }
    return {
      trusted: true,
      entries: Object.entries(deps as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name, spec]) => ({ name, spec })),
    }
  } catch (error) {
    return {
      trusted: false,
      reason: `corrupt plugin ledger ${ledgerPath}: ${error instanceof Error ? error.message : String(error)}`,
      entries: [],
    }
  }
}

/** 已装版本以 node_modules/<dep>/package.json 为准 —— 比解析 dependencies 里的 URL 可靠。 */
function readInstalledPackageVersion(dirPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf-8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * npm-ledger 扫描:以 `plugins/package.json` 的 dependencies 为账,
 * 逐个 resolve `node_modules/<dep>/plugin.json`。
 *
 * - dep 存在但包里没有 plugin.json = 它不是 onething 插件,跳过(普通依赖
 *   与插件可以共存于同一棵 node_modules);
 * - **没有运行时安装**(§5.3):tarball 在 install 时已 bundle 全部依赖,
 *   加载期缺依赖 = 包没打好,按加载失败记账。
 */
export function scanPluginLedgerDirectories<TEntry = unknown>(input: {
  pluginsDir: string
  seenIds?: Set<string>
  getEnabled: (pluginId: string) => boolean
  appVersion?: string
}): CorePluginDefinition<TEntry>[] {
  const ledger = readPluginLedger(input.pluginsDir)
  if (!ledger.trusted) {
    log.warn('npm ledger untrusted, scan skipped', { reason: ledger.reason, pluginsDir: input.pluginsDir })
    return []
  }

  const plugins: CorePluginDefinition<TEntry>[] = []
  const seen = input.seenIds ?? new Set<string>()
  const nodeModulesDir = path.join(input.pluginsDir, 'node_modules')

  for (const dep of ledger.entries) {
    const dirPath = path.join(nodeModulesDir, dep.name)
    if (!fs.existsSync(path.join(dirPath, 'plugin.json'))) continue

    const id = unscopedPluginIdFromPackageName(dep.name)
    if (seen.has(id)) {
      log.warn('npm plugin skipped, plugin id already taken', { package: dep.name, pluginId: id })
      continue
    }
    const definition = parsePluginDirectory<TEntry>({
      id,
      dirPath,
      enabled: input.getEnabled(id),
      source: 'user',
      appVersion: input.appVersion,
    })
    if (!definition) continue
    const installedVersion = readInstalledPackageVersion(dirPath)
    if (installedVersion) {
      definition.manifest = { ...definition.manifest, version: installedVersion }
    }
    plugins.push(definition)
    seen.add(definition.id)
  }

  return plugins
}

/**
 * 轻通道能接受的单文件扩展名。
 *
 * `.ts` 是规格钦定的姿态(单文件即插件),`.js`/`.mjs`/`.cjs` 是无构建即可跑的
 * 稳妥形态 —— 加载走的是与 npm/内置插件**同一个** `import()`(见 loadCorePluginEntry),
 * `.ts` 能否直接跑取决于宿主运行时是否带 TS 加载器(dev 下 vite/electron-vite 带)。
 */
const LOCAL_PLUGIN_FILE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const

function localPluginIdFromFilename(filename: string): string | null {
  // `.d.ts` 是类型声明,不是入口 —— 单独挡掉(endsWith('.ts') 会误收它)。
  if (filename.endsWith('.d.ts')) return null
  const ext = LOCAL_PLUGIN_FILE_EXTENSIONS.find(candidate => filename.endsWith(candidate))
  if (!ext) return null
  const id = filename.slice(0, -ext.length)
  return id.trim() ? id : null
}

/**
 * 轻通道扫描:`<localPluginsDir>/<name>.ts|js` 单文件 → 合成 `CorePluginDefinition`。
 *
 * **无 manifest、无 package.json、无构建**:id = 文件名去扩展名,manifest 只带
 * name/version(**没有 contributes**)。没有 contributes 就没有任何 permissions /
 * uiSlots / panels / theme 声明 —— 于是装配层的"声明先于代码"闸把所有需要声明的
 * 能力(sessions:* / llm:complete / tool_call 拦截 / 面板 / 锚点块 / 外观 …)天然
 * fail-closed 掉。这是宪法第 3 条(没有声明就没有能力)的自然结果,不是这里新加的判定。
 *
 * 与账本扫描一样:目录不存在 = 可信的空(还没建过 plugins-dev);读失败 = warn + 空,
 * 什么都不删。单个坏文件的隔离发生在**加载期**(loadCorePluginEntry 自己 try/catch),
 * 扫描期只负责列清单。
 */
export function scanLocalPluginFiles<TEntry = unknown>(input: {
  localPluginsDir: string
  seenIds?: Set<string>
  getEnabled: (pluginId: string) => boolean
}): CorePluginDefinition<TEntry>[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(input.localPluginsDir, { withFileTypes: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    // ENOENT = 还没建过 plugins-dev,可信的空;其余读失败 = warn,什么都不删。
    if (code && code !== 'ENOENT') {
      log.warn('local plugins dir unreadable, scan skipped', { localPluginsDir: input.localPluginsDir, code })
    }
    return []
  }

  const plugins: CorePluginDefinition<TEntry>[] = []
  const seen = input.seenIds ?? new Set<string>()

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    // 只认文件(含跟随符号链接到文件的情形);目录不是单文件脚本。
    if (!entry.isFile()) {
      if (!entry.isSymbolicLink()) continue
      try {
        if (!fs.statSync(path.join(input.localPluginsDir, entry.name)).isFile()) continue
      } catch {
        continue
      }
    }
    const id = localPluginIdFromFilename(entry.name)
    if (!id) continue
    if (seen.has(id)) {
      log.warn('local plugin skipped, plugin id already taken', { entry: entry.name, pluginId: id })
      continue
    }
    plugins.push({
      id,
      source: 'local',
      // 无 manifest:合成一份最小清单,**不带 contributes** —— 能力面据此收窄。
      manifest: { name: id, version: '0.0.0' },
      dirPath: input.localPluginsDir,
      entryPath: path.join(input.localPluginsDir, entry.name),
      enabled: input.getEnabled(id),
    })
    seen.add(id)
  }

  return plugins
}

export function scanCorePlugins<TEntry = unknown>(input: {
  builtinPlugins: Array<CorePluginDefinition<TEntry>>
  pluginsDir: string
  getEnabled: (pluginId: string) => boolean
  /** 宿主版本 —— 只对用户插件生效:内置插件与 app 同一份构建,永远匹配。 */
  appVersion?: string
  /**
   * 扫描语义(默认 'directory',现状不变)。
   *
   * 'npm-ledger' = **只**以 plugins/package.json 为账扫 npm 插件;desktop 传它,
   * server 等只投影的宿主保持默认。插件根下"有 plugin.json 但不在账里"的手工
   * 目录不再加载(2026-08-09 legacy 清零),也不报错 —— 它既不是插件也不是
   * 宿主管的数据家目录,孤儿扫描同样不碰它。
   */
  scanMode?: CorePluginScanMode
}): Array<CorePluginDefinition<TEntry>> {
  const seen = new Set(input.builtinPlugins.map(plugin => plugin.id))
  if (input.scanMode === 'npm-ledger') {
    return [
      ...input.builtinPlugins,
      ...scanPluginLedgerDirectories<TEntry>({
        pluginsDir: input.pluginsDir,
        seenIds: seen,
        getEnabled: input.getEnabled,
        appVersion: input.appVersion,
      }),
    ]
  }
  return [
    ...input.builtinPlugins,
    ...scanPluginDirectories<TEntry>({
      pluginsDir: input.pluginsDir,
      seenIds: seen,
      getEnabled: input.getEnabled,
      appVersion: input.appVersion,
    }),
  ]
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CorePluginLoaderLogger = CompatLogger

/**
 * 热重载:给 ESM 说明符加 cache-buster。
 *
 * 裸 `import(entryPath)` 会命中 ESM 模块缓存 —— 改一行插件代码要重启整个 app,
 * 那是平台开发体验的地板以下(对照 VS Code 的 F5 Extension Development Host)。
 * 加一个 query 就得到新的模块记录;顺带把绝对路径转成 file:// URL,
 * 这也是 Windows 上 `import('C:\\...')` 唯一能工作的形式。
 */
export function buildPluginEntryImportSpecifier(entryPath: string, reloadToken?: string | number): string {
  const isUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(entryPath)
  let specifier = entryPath
  if (!isUrl && path.isAbsolute(entryPath)) {
    specifier = pathToFileURL(entryPath).href
  }
  if (reloadToken === undefined || reloadToken === null || reloadToken === '') return specifier
  return `${specifier}${specifier.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(reloadToken))}`
}

export interface CorePluginEntryModule<TEntry = unknown> {
  default?: TEntry | unknown
}

export interface LoadCorePluginEntryAdapters<TEntry = unknown> {
  importEntry(entryPath: string): Promise<CorePluginEntryModule<TEntry>>
  isEntry?: (value: unknown) => value is TEntry
  logger?: CorePluginLoaderLogger
}

/**
 * 加载 entry 模块。
 *
 * **没有运行时依赖安装**(2026-08-09 legacy 清零):npm 形态的 tarball 在安装期
 * 已 bundle 全部依赖,加载期缺依赖 = 包没打好,按加载失败记账。
 */
export async function loadCorePluginEntry<TEntry = unknown>(
  definition: CorePluginDefinition<TEntry>,
  adapters: LoadCorePluginEntryAdapters<TEntry>,
): Promise<TEntry | null> {
  if (definition.entry) {
    return definition.entry
  }

  const logger = toLogger(adapters.logger)

  try {
    const mod = await adapters.importEntry(definition.entryPath)
    const entry = mod.default
    const isEntry = adapters.isEntry ?? ((value: unknown): value is TEntry => typeof value === 'function')
    if (isEntry(entry)) {
      return entry
    }

    logger.warn(`[PluginLoader] Plugin "${definition.id}" entry does not export a default function`)
    return null
  } catch (error) {
    logger.error(`[PluginLoader] Failed to load plugin "${definition.id}":`, undefined, error)
    return null
  }
}
