/**
 * 插件数据目录(R4)。
 *
 * **作用域已拍板:全局(per-plugin),不做 per-agent** —— 一个插件一个目录。
 * P1 之后落点是家目录 `<store>/plugins/<pluginId>/`;`<store>/plugin-data/` 只剩
 * **归档用途**(孤儿收尸的来源与 legacy-backup 的落点),没有任何读路径会去那里
 * 取数据(2026-08-09 legacy 清零时撤掉了惰性迁移)。
 * 要按 agent 分,插件自己在目录内建子结构:
 * 数据主权归插件,宿主不替它发明数据模型。
 *
 * 这一层是宪法第 6 条数据侧的地基:**插件的全部落盘足迹 = 一个目录 +
 * plugin-settings 里的三个键**。足迹可枚举,卸载与孤儿归档才有得做。
 */
import fs from 'fs'
import path from 'path'
import {
  ensureDir,
  isDirectory,
  pathExists,
  writeJsonFile,
} from '../storage/index.js'
import { describeNonSerializable } from './request-channel.js'
import { getCoreLogger } from '../logging/index.js'

const log = getCoreLogger('core.plugins')

/** 归档落点。它自己不是插件目录,孤儿扫描必须跳过它。 */
export const PLUGIN_DATA_LEGACY_BACKUP_DIR = 'legacy-backup'
/** KV 并入目录后的文件名(旧的 `<root>/<id>.json` 惰性搬进来)。 */
export const PLUGIN_KV_FILE_NAME = 'kv.json'
/** 目录内已有 kv.json 时,遗留文件的落点 —— 绝不覆盖更新的那一份。 */
export const PLUGIN_LEGACY_KV_FILE_NAME = 'kv.legacy.json'
/** 插件自有配置的文件名(家目录根,宿主管;插件经 api.settings 读写)。 */
export const PLUGIN_CONFIG_FILE_NAME = 'config.json'
/** api.storage 在家目录里的 scratch 子目录 —— 插件管的文件与宿主管的(kv/config)分层。 */
export const PLUGIN_SCRATCH_DIR_NAME = 'storage'
/** npm 代码区目录名。家目录布局下它是 plugins/ 里唯一"不许写数据"的地方。 */
export const PLUGIN_NODE_MODULES_DIR_NAME = 'node_modules'

/** plugin-settings 里属于某个插件的全部键。足迹与清理共用这一份名单。 */
export const PLUGIN_SETTINGS_KEYS = ['enabled', 'config', 'health'] as const

export type PluginStorageErrorCode =
  | 'invalid-name'
  | 'not-serializable'
  | 'unavailable'
  | 'io'
  /** 配额硬顶写超(message-state / files 面;Chrome/Figma 先例:配额由宿主持有)。 */
  | 'quota'
  /**
   * 声明门未过(F1 files 面的外部根)。**与 `unavailable` 分开**:后者是"这个宿主
   * 没有这条线",插件重试也没用;这一条是"manifest 少写了一行",作者改一行就好。
   * 两者混成一个 code,插件就只能靠读英文报错来分辨该改代码还是该放弃。
   */
  | 'not-declared'
  /** 声明过但用户还没在设置里选目录 —— 不是错误状态,是等待状态。 */
  | 'not-configured'

/**
 * 插件存储错误。
 *
 * 带 code 是为了让插件能分辨"名字写错了别重试"(invalid-name / not-serializable)
 * 与"磁盘满了稍后再试"(io);`io` 会把底层 fs 的原生 code(ENOSPC/EACCES…)
 * 透传到 `cause`,插件想细分就有得分。
 */
export class PluginStorageError extends Error {
  readonly name = 'PluginStorageError'
  /** 底层 fs 错误(code=io 时透传原生 ENOSPC/EACCES/… 供插件细分)。 */
  readonly cause?: unknown

  constructor(
    readonly code: PluginStorageErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message)
    this.cause = options.cause
  }
}

function ioError(message: string, cause: unknown): PluginStorageError {
  const nativeCode = (cause as { code?: string } | undefined)?.code
  return new PluginStorageError('io', nativeCode ? `${message} (${nativeCode})` : message, { cause })
}

/**
 * 文件名穿越防护。
 *
 * 插件给的 name 只允许是**单段文件名**:`../../.ssh/id_rsa` 与 `a/b` 都要拒。
 * 这是 in-process 时代唯一能做的沙箱 —— 插件本来就能直接 require('fs'),
 * 但 api 这条被中介的通道必须自己干净,否则 H 线把它换成 RPC 时,
 * 服务端会照单全收一个恶意路径。
 */
const FORBIDDEN_STORAGE_NAMES = new Set([
  '__proto__', 'constructor', 'prototype', '.', '..',
  // 宿主自己的东西:api.store 的 KV 与归档目录。不保留的话 api.storage 与
  // api.store 会双向静默互相 clobber。
  PLUGIN_KV_FILE_NAME,
  PLUGIN_LEGACY_KV_FILE_NAME,
  PLUGIN_DATA_LEGACY_BACKUP_DIR,
])

/** Windows 保留设备名 —— 带扩展名的形态(`CON.json`)同样被系统拒绝。 */
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

const MAX_STORAGE_NAME_BYTES = 255

export function assertSafePluginFileName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new PluginStorageError('invalid-name', 'Plugin storage name must be a non-empty string')
  }
  // NFC 归一化后再判:同一个名字的两种 Unicode 写法在 macOS 上指向同一个文件,
  // 不归一化的话保留名单可以被绕过。
  const normalized = name.normalize('NFC')
  if (normalized !== name.trim().normalize('NFC') || name !== name.trim()) {
    throw new PluginStorageError('invalid-name', `Plugin storage name "${name}" must not have surrounding whitespace`)
  }
  const value = normalized

  if (FORBIDDEN_STORAGE_NAMES.has(value.toLowerCase())) {
    throw new PluginStorageError('invalid-name', `Plugin storage name "${value}" is reserved by the host`)
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new PluginStorageError('invalid-name', `Plugin storage name "${value}" must be a single file name, not a path`)
  }
  if (value.includes('\0')) {
    throw new PluginStorageError('invalid-name', 'Plugin storage name must not contain a null byte')
  }
  // `:` 是 Windows 的 alternate data stream 分隔符 —— `a.json:hidden` 会写到
  // 一个看不见的流里。
  if (value.includes(':')) {
    throw new PluginStorageError('invalid-name', `Plugin storage name "${value}" must not contain ":"`)
  }
  if (value.endsWith('.') || value.endsWith(' ')) {
    throw new PluginStorageError('invalid-name', `Plugin storage name "${value}" must not end with a dot or space`)
  }
  if (WINDOWS_RESERVED_NAMES.has(value.split('.')[0].toLowerCase())) {
    throw new PluginStorageError('invalid-name', `Plugin storage name "${value}" is a reserved device name on Windows`)
  }
  if (Buffer.byteLength(value, 'utf-8') > MAX_STORAGE_NAME_BYTES) {
    throw new PluginStorageError('invalid-name', `Plugin storage name "${value}" exceeds ${MAX_STORAGE_NAME_BYTES} bytes`)
  }
  if (path.isAbsolute(value) || path.basename(value) !== value) {
    throw new PluginStorageError('invalid-name', `Plugin storage name "${value}" must be a single file name, not a path`)
  }
  return value
}

/**
 * 插件 id 的校验 —— 与文件名同源,但**不**套用宿主保留名单:
 * 一个叫 `kv.json` 的插件目录不会和任何东西打架。
 */
export function assertSafePluginDirName(pluginId: unknown): string {
  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
    throw new PluginStorageError('invalid-name', 'Plugin id must be a non-empty string')
  }
  const value = pluginId.normalize('NFC')
  if (value !== pluginId.trim().normalize('NFC')) {
    throw new PluginStorageError('invalid-name', `Plugin id "${pluginId}" must not have surrounding whitespace`)
  }
  if (value === '.' || value === '..' || value === PLUGIN_DATA_LEGACY_BACKUP_DIR
    || value.toLowerCase() === PLUGIN_NODE_MODULES_DIR_NAME) {
    throw new PluginStorageError('invalid-name', `Plugin id "${value}" is reserved`)
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0') || value.includes(':')) {
    throw new PluginStorageError('invalid-name', `Plugin id "${value}" must be a single directory name`)
  }
  if (path.isAbsolute(value) || path.basename(value) !== value) {
    throw new PluginStorageError('invalid-name', `Plugin id "${value}" must be a single directory name`)
  }
  return value
}

export function getCorePluginDataDir(dataRoot: string, pluginId: string): string {
  return path.join(dataRoot, assertSafePluginDirName(pluginId))
}

// ── 家目录布局(P1)──────────────────────────────
//
// npm 分发形态下,插件的全部**数据**足迹从 `<store>/plugin-data/<id>/` 搬进
// `<store>/plugins/<id>/`(家目录),与代码区 `plugins/node_modules/` 并列:
//   <pluginsDir>/<id>/config.json  自有配置(宿主管,api.settings 的落盘处)
//   <pluginsDir>/<id>/kv.json      KV(api.store)
//   <pluginsDir>/<id>/storage/     api.storage 的 scratch(插件自管的文件)
//   <pluginsDir>/legacy-backup/    归档区(卸载/孤儿/收尸共用;纯目录名,与
//                                  "legacy 目录插件"无关 —— 后者已退役)
//   <pluginsDir>/node_modules/     【一次性代码区,数据禁入】
// 判别与铁律都在这一层,上层只传根。

/** 家目录:`plugins/<id>/`。 */
export function getCorePluginHomeDir(homeRoot: string, pluginId: string): string {
  return path.join(homeRoot, assertSafePluginDirName(pluginId))
}

/** 自有配置的落点:`plugins/<id>/config.json`。 */
export function getCorePluginConfigPath(homeRoot: string, pluginId: string): string {
  return path.join(getCorePluginHomeDir(homeRoot, pluginId), PLUGIN_CONFIG_FILE_NAME)
}
/** api.storage 的 scratch 根:`plugins/<id>/storage/`。 */
export function getCorePluginScratchDir(homeRoot: string, pluginId: string): string {
  return path.join(getCorePluginHomeDir(homeRoot, pluginId), PLUGIN_SCRATCH_DIR_NAME)
}

/**
 * 铁律的执行点:`plugins/node_modules/` 下任何写操作 = 架构违规。
 *
 * npm 每次 update/uninstall 都整目录抹掉重建 —— 数据写进去,一升级就没了。
 * storage/config/KV 三条写路径各调一次;targetPath 必须**已经解析**。
 */
export function assertNotInNodeModules(homeRoot: string, targetPath: string): void {
  const nodeModules = path.resolve(homeRoot, PLUGIN_NODE_MODULES_DIR_NAME) + path.sep
  const resolved = path.resolve(targetPath) + (isDirectory(targetPath) ? path.sep : '')
  if (resolved.startsWith(nodeModules) || path.resolve(targetPath) === path.resolve(homeRoot, PLUGIN_NODE_MODULES_DIR_NAME)) {
    throw new PluginStorageError(
      'invalid-name',
      `Refusing to write plugin data into node_modules: ${targetPath} — code区是一次性的,数据禁入`,
    )
  }
}

/** KV 并入目录之前的老位置。 */
export function getCorePluginLegacyKvPath(dataRoot: string, pluginId: string): string {
  return path.join(dataRoot, `${assertSafePluginDirName(pluginId)}.json`)
}

export function getCorePluginKvPath(dataRoot: string, pluginId: string): string {
  return path.join(getCorePluginDataDir(dataRoot, pluginId), PLUGIN_KV_FILE_NAME)
}

export interface CorePluginStorage {
  /** 插件的数据目录;宿主保证它存在。 */
  dir(): string
  /**
   * 读一份 JSON。
   *
   * 三态:不存在 → fallback;损坏 → **挪 `.corrupt-<ts>` 备份并抛
   * PluginStorageError('io')**;正常 → 值。
   * 损坏时不返回 fallback,是因为插件拿到 fallback 后通常会原样写回,
   * 那一步会把损坏文件覆盖掉 —— 证据和数据一起没了。
   */
  readJson<T = unknown>(name: string, fallback?: T): T | undefined
  /** 值必须 JSON-可序列化。**Date 会落成 ISO 字符串**,读回来是 string 不是 Date。 */
  writeJson(name: string, value: unknown): void
  exists(name: string): boolean
}

export interface CorePluginMessageStateScoped {
  readJson<T = unknown>(fallback?: T): T | undefined
  writeJson(value: unknown): void
  exists(): boolean
}

/**
 * 插件侧 api.storage 的完整面:KV + 消息作用域状态(plugin-message-state-2026-08)。
 * `message(sessionId, messageId)` 返回该消息的 scoped 视图 —— 坐标随调用递交。
 */
export interface CorePluginStorageWithMessageState extends CorePluginStorage {
  message(sessionId: string, messageId: string): CorePluginMessageStateScoped
}

export interface CreateCorePluginStorageOptions {
  pluginId: string
  /**
   * 旧数据根(plugin-data)。**只在没有 homeRoot 时**作为落点 —— 桌面宿主
   * 一律给 homeRoot,这条参数留给不做家目录布局的调用方(以及归档路径)。
   */
  dataRoot?: string
  /** 家目录根(P1)。给了它,scratch 落在 `plugins/<id>/storage/`。 */
  homeRoot?: string
  /**
   * §7.4 拆除闩:卸载/停用完成后到的写 = warn + 静默丢弃 —— 晚到的写会
   * ensureDir 把刚归档的家目录复活成鬼目录。纯读不受影响(不建目录、
   * 不触发迁移)。
   */
  isDisposed?: () => boolean
}

export function createCorePluginStorage(options: CreateCorePluginStorageOptions): CorePluginStorage {
  const { pluginId, dataRoot, homeRoot } = options
  /** 只拼路径,**不建目录** —— 纯读一次就创建空目录会污染足迹。 */
  const dirPath = (): string => {
    if (homeRoot) return getCorePluginScratchDir(homeRoot, pluginId)
    if (!dataRoot) {
      throw new PluginStorageError('unavailable', `Plugin storage for "${pluginId}" has no root configured`)
    }
    return getCorePluginDataDir(dataRoot, pluginId)
  }

  let demolitionWarned = false
  const demolished = (): boolean => {
    if (!options.isDisposed?.()) return false
    if (!demolitionWarned) {
      demolitionWarned = true
      log.warn('ignoring storage writes after teardown', { pluginId })
    }
    return true
  }

  const ensuredDir = (): string => {
    const target = dirPath()
    if (homeRoot) assertNotInNodeModules(homeRoot, target)
    try {
      ensureDir(target)
    } catch (error) {
      throw ioError(`Cannot create the data directory for "${pluginId}"`, error)
    }
    return target
  }

  return {
    // 拆除闩:已拆的插件调 dir() 只拿路径不建目录(契约破例,注释即本行)。
    dir: () => (demolished() ? dirPath() : ensuredDir()),

    readJson<T = unknown>(name: string, fallback?: T): T | undefined {
      const file = path.join(dirPath(), assertSafePluginFileName(name))
      if (!pathExists(file)) return fallback

      let raw: string
      try {
        raw = fs.readFileSync(file, 'utf-8')
      } catch (error) {
        throw ioError(`Cannot read "${name}" for "${pluginId}"`, error)
      }

      try {
        return JSON.parse(raw) as T
      } catch (error) {
        // 与 plugin-settings 同一条裁决(§5.3.5):损坏就隔离,不让下一次写入
        // 以空为基底把它盖掉。
        const backup = `${file}.corrupt-${Date.now()}`
        try {
          fs.renameSync(file, backup)
        } catch (renameError) {
          log.error('quarantine failed', { pluginId, file }, renameError)
        }
        throw new PluginStorageError(
          'io',
          `"${name}" for "${pluginId}" is not valid JSON; it was moved to ${path.basename(backup)}`,
          { cause: error },
        )
      }
    },

    writeJson(name: string, value: unknown): void {
      // 拆除闩(§7.4):晚到的写静默丢弃,不重建家目录。
      if (demolished()) return
      const safeName = assertSafePluginFileName(name)
      // 过线皆可序列化(宪法第 2 条)—— 写盘也是一条"线":一个 Map 落进 JSON
      // 会静默变成 `{}`,那是最难查的一类数据丢失。
      const problem = describeNonSerializable(value, `storage value for "${safeName}"`)
      if (problem) {
        throw new PluginStorageError('not-serializable', `Plugin storage value must be JSON-serializable: ${problem}`)
      }
      try {
        writeJsonFile(path.join(ensuredDir(), safeName), value)
      } catch (error) {
        throw ioError(`Cannot write "${name}" for "${pluginId}"`, error)
      }
    },

    exists(name: string): boolean {
      return pathExists(path.join(dirPath(), assertSafePluginFileName(name)))
    },
  }
}

// ── 消息作用域状态存储(plugin-message-state-2026-08) ──────────────

/** 消息态在家目录里的子目录 —— 与 kv.json / storage/ 平级分账。 */
export const PLUGIN_MESSAGE_STATE_DIR_NAME = 'message-state'
/** 每插件消息态配额硬顶(§3.4:宿主持有配额,先例 Chrome 10MB / Figma 100KB/条)。 */
export const PLUGIN_MESSAGE_STATE_DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024

export interface CorePluginMessageStateStore {
  /** 读一条消息态;不存在 → fallback。水合即真源,损坏记录在**水合时**隔离并跳过。 */
  readJson<T = unknown>(sessionId: string, messageId: string, fallback?: T): T | undefined
  /** 写一条消息态。值必须 JSON-可序列化;超配额 → PluginStorageError('quota')(写面抛)。 */
  writeJson(sessionId: string, messageId: string, value: unknown): void
  exists(sessionId: string, messageId: string): boolean
  /** 级联入口(runtime 挂 message:deleted):清该条(缓存 + 磁盘)。 */
  handleMessageDeleted(sessionId: string, messageId: string): void
  /** 级联入口(runtime 挂 session:deleted):清整个会话目录。 */
  handleSessionDeleted(sessionId: string): void
  /** 当前占用字节(配额与测试观测)。 */
  totalBytes(): number
}

export interface CreateCorePluginMessageStateStoreOptions {
  pluginId: string
  homeRoot: string
  /**
   * lifetime 闸门(§3.2):插件任一 uiSlot 声明 'persistent' → 落盘 + 创建时水合;
   * 否则纯内存(重启即丢,ephemeral 语义)。
   */
  persistent: boolean
  /** §7.4 拆除闩:卸载/停用完成后到的写 = warn + 静默丢弃(与 KV 同一条闩)。 */
  isDisposed?: () => boolean
  /** 配额硬顶字节数,默认 5MB。 */
  quotaBytes?: number
}

export function getCorePluginMessageStateDir(homeRoot: string, pluginId: string): string {
  return path.join(getCorePluginHomeDir(homeRoot, pluginId), PLUGIN_MESSAGE_STATE_DIR_NAME)
}

export function createCorePluginMessageStateStore(
  options: CreateCorePluginMessageStateStoreOptions,
): CorePluginMessageStateStore {
  const { pluginId, homeRoot, persistent } = options
  const quota = options.quotaBytes ?? PLUGIN_MESSAGE_STATE_DEFAULT_QUOTA_BYTES
  const rootDir = getCorePluginMessageStateDir(homeRoot, pluginId)
  assertNotInNodeModules(homeRoot, rootDir)

  /** 真源:`<sid>/<mid>` → 序列化后的 JSON 文本(与落盘字节同形)。 */
  const cache = new Map<string, string>()
  let bytes = 0

  const keyOf = (sessionId: string, messageId: string): string =>
    `${assertSafePluginFileName(sessionId)}/${assertSafePluginFileName(messageId)}`
  const fileOf = (key: string): string => path.join(rootDir, `${key}.json`)

  // 创建时水合(仅 persistent):目录遍历即索引。损坏记录:挪 .corrupt-<ts>
  // 隔离并跳过 —— 插件加载不能死在一条坏记录上(与 KV 读面抛不同:渲染路径
  // 的读必须扛得住,损坏在水合这一道一次清完)。
  if (persistent && pathExists(rootDir)) {
    for (const sid of fs.readdirSync(rootDir)) {
      const sidDir = path.join(rootDir, sid)
      if (!isDirectory(sidDir)) continue
      for (const file of fs.readdirSync(sidDir)) {
        if (!file.endsWith('.json') || file.includes('.corrupt-')) continue
        const full = path.join(sidDir, file)
        try {
          const raw = fs.readFileSync(full, 'utf-8')
          JSON.parse(raw) // 只验形,真源就是文本
          const key = `${sid}/${file.slice(0, -5)}`
          cache.set(key, raw)
          bytes += raw.length
        } catch {
          try {
            fs.renameSync(full, `${full}.corrupt-${Date.now()}`)
          } catch (renameError) {
            log.error('message-state quarantine failed', { pluginId, file: full }, renameError)
          }
          log.error('corrupt message-state record quarantined', { pluginId, file: full })
        }
      }
    }
  }

  let demolitionWarned = false
  const demolished = (): boolean => {
    if (!options.isDisposed?.()) return false
    if (!demolitionWarned) {
      demolitionWarned = true
      log.warn('ignoring message-state writes after teardown', { pluginId })
    }
    return true
  }

  return {
    readJson<T = unknown>(sessionId: string, messageId: string, fallback?: T): T | undefined {
      const raw = cache.get(keyOf(sessionId, messageId))
      if (raw === undefined) return fallback
      return JSON.parse(raw) as T
    },

    writeJson(sessionId: string, messageId: string, value: unknown): void {
      // 拆除闩(§7.4):晚到的写静默丢弃,不重建家目录。
      if (demolished()) return
      const key = keyOf(sessionId, messageId)
      // 与 KV 同一条宪法:写盘也是一条"线",不可序列化的值会静默丢数据。
      const problem = describeNonSerializable(value, `message-state value for "${key}"`)
      if (problem) {
        throw new PluginStorageError('not-serializable', `Plugin message-state value must be JSON-serializable: ${problem}`)
      }
      const raw = JSON.stringify(value, null, 2)
      const replaced = cache.get(key)
      const nextTotal = bytes - (replaced?.length ?? 0) + raw.length
      if (nextTotal > quota) {
        throw new PluginStorageError(
          'quota',
          `Message-state for "${pluginId}" exceeds the ${quota}-byte quota (${nextTotal} after write)`,
        )
      }
      cache.set(key, raw)
      bytes = nextTotal
      if (persistent) {
        try {
          writeJsonFile(fileOf(key), value)
        } catch (error) {
          throw ioError(`Cannot write message-state "${key}" for "${pluginId}"`, error)
        }
      }
    },

    exists(sessionId: string, messageId: string): boolean {
      return cache.has(keyOf(sessionId, messageId))
    },

    handleMessageDeleted(sessionId: string, messageId: string): void {
      const key = keyOf(sessionId, messageId)
      const raw = cache.get(key)
      if (raw !== undefined) {
        cache.delete(key)
        bytes -= raw.length
      }
      if (persistent) {
        try {
          fs.rmSync(fileOf(key), { force: true })
        } catch (error) {
          log.error('message-state cascade delete failed', { pluginId, key }, error)
        }
      }
    },

    handleSessionDeleted(sessionId: string): void {
      const sid = assertSafePluginFileName(sessionId)
      for (const [key, raw] of [...cache]) {
        if (key.startsWith(`${sid}/`)) {
          cache.delete(key)
          bytes -= raw.length
        }
      }
      if (persistent) {
        try {
          fs.rmSync(path.join(rootDir, sid), { recursive: true, force: true })
        } catch (error) {
          log.error('message-state session cascade delete failed', { pluginId, sessionId: sid }, error)
        }
      }
    },

    totalBytes(): number {
      return bytes
    },
  }
}

// ── 足迹与归档 ────────────────────────────────

export interface CorePluginDataFootprint {
  pluginId: string
  /** 数据目录(可能尚不存在)。 */
  dataDir: string
  dataDirExists: boolean
  /** 目录内的文件名(单层;插件自建的子目录只报目录名)。 */
  entries: string[]
  /** 尚未迁移的旧 KV 文件。 */
  legacyKvPath: string
  legacyKvExists: boolean
  /** plugin-settings 里为它保留的键(由宿主注入实际存在的那些)。 */
  settingsKeys: string[]
}

export function getCorePluginDataFootprint(
  dataRoot: string,
  pluginId: string,
  options: { settingsKeys?: string[] } = {},
): CorePluginDataFootprint {
  const dataDir = getCorePluginDataDir(dataRoot, pluginId)
  const legacyKvPath = getCorePluginLegacyKvPath(dataRoot, pluginId)
  let entries: string[] = []
  const dataDirExists = isDirectory(dataDir)
  if (dataDirExists) {
    try {
      entries = fs.readdirSync(dataDir).sort()
    } catch {
      entries = []
    }
  }
  return {
    pluginId,
    dataDir,
    dataDirExists,
    entries,
    legacyKvPath,
    legacyKvExists: pathExists(legacyKvPath),
    settingsKeys: options.settingsKeys ?? [],
  }
}

function formatArchiveDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 归档目标带日期;同日重复归档时加序号。
 *
 * 撞名时**不覆盖**:归档的全部意义就是"删之前留一份",覆盖掉上一次归档等于
 * 把它删了两次。
 */
function resolveArchiveTarget(dataRoot: string, pluginId: string, now: Date): string {
  const backupRoot = path.join(dataRoot, PLUGIN_DATA_LEGACY_BACKUP_DIR)
  const base = path.join(backupRoot, `${pluginId}-${formatArchiveDate(now)}`)
  if (!pathExists(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!pathExists(candidate)) return candidate
  }
  throw new PluginStorageError('io', `Cannot find a free archive slot for "${pluginId}"`)
}

export interface ArchiveCorePluginDataResult {
  archived: boolean
  archivePath?: string
  error?: string
}

/**
 * 把一个插件的数据整体挪进 legacy-backup。
 *
 * **先并后搬**:遗留的 `<id>.json` 先并进数据目录(目录里已有 kv.json 就落
 * `kv.legacy.json` —— 用旧文件压掉更新的那一份,等于安全网自己毁数据),
 * 然后**单次整目录 rename**。这样"半归档"这个中间态不存在:
 * 并入失败就整个不动,rename 失败就把并入回滚。
 *
 * 失败**不抛**:卸载/孤儿归档都是多步流程,归档失败时原数据要留在原地
 * 让调用方能报出来,而不是把整条流程带崩、留下半拆状态。
 */
export function archiveCorePluginData(
  dataRoot: string,
  pluginId: string,
  options: { now?: Date } = {},
): ArchiveCorePluginDataResult {
  let footprint: CorePluginDataFootprint
  try {
    footprint = getCorePluginDataFootprint(dataRoot, pluginId)
  } catch (error) {
    return { archived: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!footprint.dataDirExists && !footprint.legacyKvExists) {
    return { archived: false }
  }

  // 第一步:遗留文件并进数据目录。记下回滚所需的信息。
  let mergedFrom: string | undefined
  let mergedTo: string | undefined
  try {
    if (footprint.legacyKvExists) {
      ensureDir(footprint.dataDir)
      const targetName = pathExists(getCorePluginKvPath(dataRoot, pluginId))
        ? PLUGIN_LEGACY_KV_FILE_NAME
        : PLUGIN_KV_FILE_NAME
      const target = path.join(footprint.dataDir, targetName)
      if (pathExists(target)) {
        return {
          archived: false,
          error: `Cannot merge the legacy KV file: ${targetName} already exists for "${pluginId}"`,
        }
      }
      fs.renameSync(footprint.legacyKvPath, target)
      mergedFrom = footprint.legacyKvPath
      mergedTo = target
    }
  } catch (error) {
    log.error('legacy kv merge failed', { pluginId }, error)
    return { archived: false, error: error instanceof Error ? error.message : String(error) }
  }

  // 第二步:单次整目录 rename。
  try {
    const target = resolveArchiveTarget(dataRoot, pluginId, options.now ?? new Date())
    ensureDir(path.dirname(target))
    fs.renameSync(footprint.dataDir, target)
    return { archived: true, archivePath: target }
  } catch (error) {
    // 回滚第一步,否则遗留文件会停在数据目录里,而调用方以为什么都没发生。
    if (mergedFrom && mergedTo) {
      try {
        fs.renameSync(mergedTo, mergedFrom)
      } catch (rollbackError) {
        log.error('legacy kv merge rollback failed', { pluginId }, rollbackError)
      }
    }
    const nativeCode = (error as { code?: string } | undefined)?.code
    const message = nativeCode === 'EXDEV'
      // 跨卷 rename 不可用:copy+verify+delete 降级已裁决不做,至少把原因说清楚。
      ? `Cannot archive "${pluginId}": the data directory and the backup folder are on different volumes (EXDEV)`
      : error instanceof Error ? error.message : String(error)
    log.error('plugin data archive failed', { pluginId }, error)
    return { archived: false, error: message }
  }
}

/** 把归档搬回原位 —— 卸载在删源目录失败时的补偿动作。 */
export function restoreCorePluginDataArchive(
  dataRoot: string,
  pluginId: string,
  archivePath: string,
): { restored: boolean; error?: string } {
  try {
    const dataDir = getCorePluginDataDir(dataRoot, pluginId)
    if (pathExists(dataDir)) {
      return { restored: false, error: `Cannot restore "${pluginId}": its data directory already exists again` }
    }
    fs.renameSync(archivePath, dataDir)
    return { restored: true }
  } catch (error) {
    return { restored: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface CorePluginDataOrphan {
  pluginId: string
  kind: 'directory' | 'legacy-kv'
}

/**
 * 无主数据:既不是内置插件也不是已安装的用户插件。
 *
 * 手删 `<store>/plugins/<id>/` 是真实存在的卸载路径(在 R4 之前是**唯一**的),
 * 宿主对它零感知,数据就永远躺在那儿。这条扫描把它收口。
 *
 * **比较大小写不敏感**:macOS/Windows 的默认文件系统就是这样,区分大小写的话
 * `Notes` 与 `notes` 会互判孤儿。
 */
export function findCorePluginDataOrphans(dataRoot: string, knownPluginIds: Iterable<string>): CorePluginDataOrphan[] {
  if (!isDirectory(dataRoot)) return []
  const known = new Set([...knownPluginIds].map(id => id.normalize('NFC').toLowerCase()))
  const orphans: CorePluginDataOrphan[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dataRoot, { withFileTypes: true })
  } catch (error) {
    // 读不动就什么都不做 —— 读失败不是"这里没有插件"。
    log.error('orphan scan failed', { dataRoot }, error)
    return []
  }

  for (const entry of entries) {
    // 逐项 try:一个畸形名不该让整轮扫描停摆。
    try {
      if (entry.name === PLUGIN_DATA_LEGACY_BACKUP_DIR) continue
      if (entry.name.startsWith('.')) continue

      if (entry.isDirectory()) {
        assertSafePluginDirName(entry.name)
        if (!known.has(entry.name.normalize('NFC').toLowerCase())) {
          orphans.push({ pluginId: entry.name, kind: 'directory' })
        }
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const pluginId = entry.name.slice(0, -'.json'.length)
        assertSafePluginDirName(pluginId)
        if (!known.has(pluginId.normalize('NFC').toLowerCase())) {
          orphans.push({ pluginId, kind: 'legacy-kv' })
        }
      }
    } catch (error) {
      log.warn('skipping unusable plugin-data entry', { entry: entry.name }, error)
    }
  }

  return orphans.sort((a, b) => a.pluginId.localeCompare(b.pluginId))
}

/**
 * P1:`plugins/` 下的**家目录孤儿**。
 *
 * 家目录的"主"是码,不是目录本身:npm 形态的码在 node_modules(账 + 包)。
 * 所以家目录孤儿 = 无 plugin.json 且 id 不在存活集合里的纯数据目录。
 * **带 plugin.json 的目录一律跳过**:那是手工放进来的代码目录,宿主自 2026-08-09
 * 起不再加载它(legacy 清零),但它也不是宿主管的数据 —— 不加载、不归档、
 * 不动它,交给人处置。`legacy-backup` 自身永远不是候选 —— 把归档目录归档进
 * 它自己是最难看的一种死循环。
 *
 * 调用方负责传**可信**的存活集合(账本不可信时整轮弃权,见 manager)。
 */
export function findCorePluginHomeOrphans(
  pluginsDir: string,
  alivePluginIds: Iterable<string>,
): CorePluginDataOrphan[] {
  if (!isDirectory(pluginsDir)) return []
  const alive = new Set([...alivePluginIds].map(id => id.normalize('NFC').toLowerCase()))
  const orphans: CorePluginDataOrphan[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
  } catch (error) {
    // 与 plugin-data 同一条:读失败不是"这里没有插件"。
    log.error('orphan home scan failed', { pluginsDir }, error)
    return []
  }

  for (const entry of entries) {
    try {
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules' || entry.name === PLUGIN_DATA_LEGACY_BACKUP_DIR) continue
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const dirPath = path.join(pluginsDir, entry.name)
      // 有 plugin.json = 手工放进来的代码目录(宿主已不再加载),不是数据家目录。
      if (pathExists(path.join(dirPath, 'plugin.json'))) continue
      assertSafePluginDirName(entry.name)
      if (!alive.has(entry.name.normalize('NFC').toLowerCase())) {
        orphans.push({ pluginId: entry.name, kind: 'directory' })
      }
    } catch (error) {
      log.warn('skipping unusable plugins entry', { entry: entry.name }, error)
    }
  }

  return orphans.sort((a, b) => a.pluginId.localeCompare(b.pluginId))
}

/**
 * 自动归档的安全闸(评审 critical)。
 *
 * `existsSync` 在**任何** stat 错误下都返回 false(EACCES / EIO / fd 耗尽 /
 * 网络卷瞬断 / 用户临时 mv 走 plugins 目录),扫描于是返回空列表 ——
 * 而空列表的字面意思是"一个插件都没装",接下来 plugin-data 下**每一个**目录
 * 都会被判孤儿搬走。所以:扫描不可信、或者"一个用户插件都没有却要归档一堆",
 * 一律拒绝自动归档,改为请人来看。
 */
export const PLUGIN_ORPHAN_ARCHIVE_LIMIT = 3

export interface PluginOrphanArchiveDecision {
  proceed: boolean
  reason?: string
}

export function decidePluginOrphanArchive(input: {
  orphans: CorePluginDataOrphan[]
  /** 扫描是否可信(读失败时为 false)。 */
  scanTrusted: boolean
  /** 本轮扫到的用户插件数量。 */
  userPluginCount: number
  limit?: number
}): PluginOrphanArchiveDecision {
  if (input.orphans.length === 0) return { proceed: true }

  if (!input.scanTrusted) {
    return {
      proceed: false,
      reason: 'the plugins directory could not be read reliably this round',
    }
  }
  if (input.userPluginCount === 0) {
    return {
      proceed: false,
      reason: 'no user plugins were found at all, which usually means the plugins directory is unavailable',
    }
  }
  const limit = input.limit ?? PLUGIN_ORPHAN_ARCHIVE_LIMIT
  if (input.orphans.length > limit) {
    return {
      proceed: false,
      reason: `${input.orphans.length} orphan candidates exceed the safety limit of ${limit}`,
    }
  }
  return { proceed: true }
}
