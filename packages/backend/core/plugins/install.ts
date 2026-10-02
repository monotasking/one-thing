/**
 * P1:npm 生命周期 —— 装/更/卸的命令链(core 层,零依赖)。
 *
 * 分层:这里只**编排** —— 脚手架 → npm install → 装后校验(零运行时依赖、
 * SRI 完整性)→ 不合格回滚。npm 机制本身(spawn、超时、Windows 的 npm.cmd)
 * 是宿主适配器 `runNpm`,测试可以整个换掉。
 *
 * 关键拍板(设计 §6):
 *  - `--ignore-scripts` 是安全底线:tarball 的 pre/postinstall 会在熔断、
 *    manifest 审查、用户确认之前执行;bundle 规则下插件本就不需要 install
 *    脚本,装上即跑脚本 = 装插件即得任意代码执行的后门。
 *  - 装后校验零运行时 dependencies:有依赖 = npm 会去 registry 现拉,
 *    供应链与网络都不确定;bundle 规则(§9.4)要求全量打包。
 *  - 完整性比对走 npm 原生格式:市场索引给 sha512-SRI,装后读
 *    package-lock 该条目的 integrity,不符即回滚拒载。
 */
import fs from 'fs'
import { toLogger } from '../logging/index.js'
import path from 'path'
import { writeJsonFile } from '../storage/json-file.js'
import {
  compareCoreSemver,
  unscopedPluginIdFromPackageName,
  type CorePluginLoaderLogger,
} from './loader.js'

export const PLUGIN_LEDGER_FILE_NAME = 'package.json'
export const PLUGIN_LOCK_FILE_NAME = 'package-lock.json'

/** npm install/uninstall 的公共旗标。--ignore-scripts 是安全底线,见文件头。 */
export const PLUGIN_NPM_LIFECYCLE_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'] as const

/**
 * 脚手架:`plugins/package.json` 不存在时先写。
 *
 * npm 在无 package.json 的目录里建账不可靠(会向上找最近的 package.json,
 * 把依赖记到别人家账上);`private: true` 防误发布。
 */
export function ensurePluginLedgerScaffold(pluginsDir: string): { created: boolean; error?: string } {
  const ledgerPath = path.join(pluginsDir, PLUGIN_LEDGER_FILE_NAME)
  if (fs.existsSync(ledgerPath)) return { created: false }
  try {
    fs.mkdirSync(pluginsDir, { recursive: true })
    writeJsonFile(ledgerPath, {
      private: true,
      name: 'onething-installed-plugins',
      dependencies: {},
    })
    return { created: true }
  } catch (error) {
    return { created: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface CorePluginNpmRunResult {
  code: number
  stderr: string
}

export interface CorePluginNpmAdapters {
  runNpm(args: string[], cwd: string): Promise<CorePluginNpmRunResult>
  logger?: CorePluginLoaderLogger
}

function npmError(context: string, result: CorePluginNpmRunResult): string {
  const detail = result.stderr.trim()
  return detail ? `${context}: ${detail}` : `${context} (npm exited with code ${result.code})`
}

/** 读 package-lock 中某包的 integrity(npm 原生 SRI 格式);没有锁条目 = undefined。 */
export function readPackageLockIntegrity(pluginsDir: string, pkg: string): string | undefined {
  const lockPath = path.join(pluginsDir, PLUGIN_LOCK_FILE_NAME)
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
      packages?: Record<string, { integrity?: unknown }>
    }
    const entry = lock.packages?.[`node_modules/${pkg}`]
    return typeof entry?.integrity === 'string' ? entry.integrity : undefined
  } catch {
    return undefined
  }
}

/** 包内 package.json 的运行时 dependencies(bundle 规则:必须为零)。 */
export function readInstalledRuntimeDeps(dirPath: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf-8')) as { dependencies?: unknown }
    if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) return {}
    return pkg.dependencies as Record<string, string>
  } catch {
    return {}
  }
}

/** 包内 package.json 的 name(账货一致性校验:装上的必须是要装的)。 */
export function readInstalledPackageName(dirPath: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf-8')) as { name?: unknown }
    return typeof pkg.name === 'string' ? pkg.name : undefined
  } catch {
    return undefined
  }
}

/** 读账本里某包当前的 spec(update 回滚旧版用 —— 我们的版本真相在账本,不在 registry)。 */
export function readPluginLedgerSpec(pluginsDir: string, pkg: string): string | undefined {
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(pluginsDir, PLUGIN_LEDGER_FILE_NAME), 'utf-8')) as {
      dependencies?: Record<string, unknown>
    }
    const spec = ledger.dependencies?.[pkg]
    return typeof spec === 'string' ? spec : undefined
  } catch {
    return undefined
  }
}

export interface InstallCorePluginPackageInput {
  /** 包名(带不带 scope 都行;pluginId = 去 scope)。必须与包内 package.json 的 name 一致。 */
  pkg: string
  /** npm install 的 spec:tarball URL 或 file:<路径>。 */
  spec: string
  /** 期望的 sha512-SRI;给了就与 package-lock 里的条目比对,不给 = 跳过(file: 开发通道)。 */
  integrity?: string
}

export interface InstallCorePluginPackageResult {
  ok: boolean
  /** 包名去 scope —— 装失败时也带上(错误上下文)。 */
  pluginId: string
  error?: string
}

export async function installCorePluginPackage(
  pluginsDir: string,
  input: InstallCorePluginPackageInput,
  adapters: CorePluginNpmAdapters,
): Promise<InstallCorePluginPackageResult> {
  const logger = toLogger(adapters.logger)
  const pluginId = unscopedPluginIdFromPackageName(input.pkg)

  // spec 协议白名单(端到端审查 S3):市场 URL 只走 https,开发通道走 file:。
  // git+/ssh/ftp/http 等 npm 支持的其它协议一律不收 —— 索引内容真被写坏时,
  // 纵深防御在这里拦最后一道(信任根是索引仓库,但闸多一道不亏)。
  if (!input.spec.startsWith('https://') && !input.spec.startsWith('file:')) {
    return {
      ok: false,
      pluginId,
      error: `Refusing to install ${input.pkg}: spec must be an https:// tarball URL or a file: path (got "${input.spec.slice(0, 64)}")`,
    }
  }

  // 0. 脚手架
  const scaffold = ensurePluginLedgerScaffold(pluginsDir)
  if (scaffold.error) {
    return { ok: false, pluginId, error: `Failed to scaffold the plugin ledger: ${scaffold.error}` }
  }

  // 装后校验不过关时的回滚:把 npm 状态退回装前,错误原样透传。
  const rollback = async (reason: string): Promise<InstallCorePluginPackageResult> => {
    logger.warn(`[PluginInstall] ${reason} — rolling back npm state for ${input.pkg}`)
    const undo = await adapters.runNpm(['uninstall', input.pkg, ...PLUGIN_NPM_LIFECYCLE_FLAGS], pluginsDir)
    if (undo.code !== 0) {
      logger.error(`[PluginInstall] Rollback npm uninstall failed for ${input.pkg}: ${undo.stderr.trim()}`)
    }
    return { ok: false, pluginId, error: reason }
  }

  // 1. npm install <spec>
  logger.debug(`[PluginInstall] Installing ${input.pkg} from ${input.spec}...`)
  const installed = await adapters.runNpm(['install', input.spec, ...PLUGIN_NPM_LIFECYCLE_FLAGS], pluginsDir)
  if (installed.code !== 0) {
    return { ok: false, pluginId, error: npmError(`npm install failed for ${input.pkg}`, installed) }
  }

  const dirPath = path.join(pluginsDir, 'node_modules', input.pkg)
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) {
    return rollback(`npm reported success but ${input.pkg} is not present under node_modules`)
  }

  // 1.5 包名一致性(端到端审查 S4):node_modules/<pkg>/package.json 的 name
  // 必须等于 pkg —— 索引把 pkg 写错名时会装成第二个包,账货分叉。
  const installedName = readInstalledPackageName(dirPath)
  if (installedName !== input.pkg) {
    return rollback(
      `Package name mismatch for ${input.pkg}: the installed package is named "${installedName ?? 'unreadable'}"`,
    )
  }

  // 2a. 零运行时 dependencies(bundle 规则)。有则拒载并回滚。
  const runtimeDeps = readInstalledRuntimeDeps(dirPath)
  const depNames = Object.keys(runtimeDeps)
  if (depNames.length > 0) {
    return rollback(
      `Plugin package ${input.pkg} declares runtime dependencies (${depNames.join(', ')}); `
      + 'plugins must ship fully bundled',
    )
  }

  // 2b. 完整性:市场索引给的 SRI vs package-lock 条目;不符即回滚拒载。
  if (input.integrity) {
    const locked = readPackageLockIntegrity(pluginsDir, input.pkg)
    if (!locked) {
      return rollback(`Cannot verify integrity for ${input.pkg}: no package-lock entry was written`)
    }
    if (locked !== input.integrity) {
      return rollback(
        `Integrity mismatch for ${input.pkg}: expected ${input.integrity} but the lockfile has ${locked}; refusing to load`,
      )
    }
  }

  logger.debug(`[PluginInstall] Installed ${input.pkg}`)
  return { ok: true, pluginId }
}

export async function uninstallCorePluginPackage(
  pluginsDir: string,
  pkg: string,
  adapters: CorePluginNpmAdapters,
): Promise<{ removed: boolean; error?: string }> {
  const result = await adapters.runNpm(['uninstall', pkg, ...PLUGIN_NPM_LIFECYCLE_FLAGS], pluginsDir)
  if (result.code !== 0) return { removed: false, error: npmError(`npm uninstall failed for ${pkg}`, result) }
  return { removed: true }
}

// ── 市场索引(P1:类型 + 纯函数;拉取与缓存在宿主,P3 做 UI)──

export interface CorePluginMarketIndexEntry {
  id: string
  pkg: string
  version: string
  description?: string
  author?: string
  minAppVersion?: string
  contributes?: unknown
  tarballUrl: string
  /** CI 对 tarball 实体算的 sha512-SRI。 */
  integrity?: string
  repository?: string
}

export interface CorePluginMarketIndex {
  version: number
  generatedAt?: string
  plugins: CorePluginMarketIndexEntry[]
}

/** 按 pluginId 找索引条目(id 直查,或包名去 scope 后命中)。 */
export function findMarketIndexEntry(
  index: CorePluginMarketIndex,
  pluginId: string,
): CorePluginMarketIndexEntry | undefined {
  return index.plugins.find(entry => entry.id === pluginId
    || unscopedPluginIdFromPackageName(entry.pkg) === pluginId)
}

/** 索引版本 > 已装版本才有更新;轻量 semver 比较复用 loader 实现。 */
export function findPluginUpdate(
  index: CorePluginMarketIndex,
  pluginId: string,
  currentVersion: string,
): { latest: string; entry: CorePluginMarketIndexEntry } | null {
  const entry = findMarketIndexEntry(index, pluginId)
  if (!entry) return null
  if (compareCoreSemver(entry.version, currentVersion) <= 0) return null
  return { latest: entry.version, entry }
}
