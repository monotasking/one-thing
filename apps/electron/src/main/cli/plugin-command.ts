/**
 * CLI 的 `plugin` 命令域 —— install / list / uninstall。
 *
 * 与其它 scope 的关键差别:**不经 daemon**。插件只在 Electron 桌面宿主执行
 * (plan A),CLI daemon 根本不装配插件系统,所以这里也不走 PluginManager,
 * 直接调 `@onething/backend/plugins/install.js` 那层宿主无关的安装机器 ——
 * 它只动账本(`<store>/plugins/package.json`)与 `node_modules/`,不加载任何
 * 插件代码。代价是装完不会热生效,每次成功后都得把这句话说给用户听。
 *
 * 之所以独立成文件(其它 scope 都内联在 index.ts):index.ts 顶层就 `main()`,
 * 单测一 import 就会真的跑起来。命令逻辑放这里才测得动。
 *
 * store 路径:main() 已经把 `--store` 写进 `ONETHING_STORE_PATH`,
 * `getPluginsDir()` 自己经 `getOnethingStorePath()` 解析,这里不碰路径字面量。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_MARKET_INDEX_URL } from '@shared/ipc/plugins.js'
// 这些必须是**静态** import,而且不只是风格问题:cli 与 Electron 主进程在同一张
// rollup 图里打包,一个只被主进程入口静态引用的模块会被内联进 out/main/index.js;
// 若这里用动态 import,会被解析成 import("../index.js") —— 纯 node 进程加载整个
// Electron 主进程,当场炸在 electron 的 CJS named export 上。静态引用让这些模块
// 拥有第二个引用方,rollup 必须把它们拆成不含 electron 的共享 chunk。
// (plugin-command 自身仍由 index.ts 动态 import,文件级惰性不丢。)
import {
  configurePluginMarketIndex,
  getPluginMarketIndexSnapshot,
  installPluginPackage,
  probePluginNpmAvailability,
  uninstallPluginPackage,
} from '@onething/backend/plugins/install.js'
import { PLUGIN_PACKAGE_SCOPE, readPluginTarballSummary } from '@onething/backend/plugins/tarball.js'
import { getPluginsDir } from '@onething/backend/plugins/loader.js'
import {
  findMarketIndexEntry,
  readPluginLedger,
  unscopedPluginIdFromPackageName,
} from '@onething/core/plugins'
import type { CorePluginMarketIndex } from '@onething/core/plugins'
import { stdout, stderr } from './stdout.js'

/** 装完/卸完的提示 —— CLI 不加载插件,桌面那边要自己刷新。 */
const REFRESH_HINT
  = 'Restart the desktop app, or open Settings → Plugins → Refresh, for this to take effect '
  + '(the CLI never loads plugins).'

export async function pluginCommand(command: string | undefined, rest: string[]): Promise<void> {
  switch (command) {
    case 'install':
      await installPlugins(rest)
      break
    case 'list':
      await listPlugins()
      break
    case 'uninstall':
      await uninstallPlugin(rest[0])
      break
    default:
      throw new Error(`Unknown plugin command: ${command ?? '(missing)'}`)
  }
}

// ── install ──

/**
 * 多参数串行装。
 *
 * 串行不是保守,是账本形态决定的:`plugins/package.json` 是单文件,并发 npm
 * 会互相盖写。单败不中断(设置页多选同理),退出码全成 0 / 有败非 0。
 */
async function installPlugins(targets: string[]): Promise<void> {
  if (targets.length === 0) {
    throw new Error('plugin install requires at least one <path.tgz> or <market id>')
  }

  // 裁决 8:v1 依赖本机 npm。点了才炸不如装前明说 —— 桌面设置页也是这条裁决。
  if (!await probePluginNpmAvailability()) {
    throw new Error(
      'npm was not found (plugin install shells out to the local npm). '
      + 'Install Node.js/npm and make sure `npm --version` works, then retry.',
    )
  }

  const pluginsDir = resolvePluginsDir()
  // 市场索引只在第一次真要用时拉一次:全是本地 .tgz 的场景不该起网络。
  let market: CorePluginMarketIndex | null | undefined
  let failures = 0

  for (const target of targets) {
    if (looksLikeLocalTarball(target)) {
      const filePath = path.resolve(target)
      const summary = readPluginTarballSummary(filePath)
      if (!summary.success || !summary.summary) {
        stderr(`✗ ${target}: ${summary.error ?? 'cannot read the tarball'} [${summary.errorCode ?? 'unknown'}]`)
        failures += 1
        continue
      }
      // 包名从 tarball 里读 —— 用户不手输包名,手输的包名和包内 name 不符
      // 会在 core 的装后校验里回滚,那时候钱已经花了。
      const { pkg, version, manifestIssue } = summary.summary
      if (manifestIssue) stderr(`! ${pkg}: ${manifestIssue}`)
      stdout(`Installing ${pkg}@${version} from ${filePath} ...`)
      const result = await installPluginPackage(pluginsDir, { pkg, spec: `file:${filePath}` })
      if (!result.ok) {
        stderr(`✗ ${pkg}: ${result.error ?? 'install failed'}`)
        failures += 1
        continue
      }
      stdout(`✓ installed ${result.pluginId} (${pkg}@${version})`)
      stdout(`  ${REFRESH_HINT}`)
      continue
    }

    // 市场通道:id → 索引条目 → pkg / tarballUrl / integrity。
    if (market === undefined) market = await fetchMarketIndex()
    if (!market) {
      stderr(`✗ ${target}: the plugin market index is unavailable, so a market id cannot be resolved`)
      failures += 1
      continue
    }
    const wanted = unscopedPluginIdFromPackageName(target)
    const entry = findMarketIndexEntry(market, wanted)
    if (!entry) {
      const available = market.plugins.map(item => item.id).sort()
      stderr(
        `✗ ${target}: no such plugin in the market index. `
        + (available.length > 0 ? `Available ids: ${available.join(', ')}` : 'The index lists no plugins.'),
      )
      failures += 1
      continue
    }
    stdout(`Installing ${entry.pkg}@${entry.version} from ${entry.tarballUrl} ...`)
    const result = await installPluginPackage(pluginsDir, {
      pkg: entry.pkg,
      spec: entry.tarballUrl,
      integrity: entry.integrity,
    })
    if (!result.ok) {
      stderr(`✗ ${entry.id}: ${result.error ?? 'install failed'}`)
      failures += 1
      continue
    }
    stdout(`✓ installed ${result.pluginId} (${entry.pkg}@${entry.version})`)
    stdout(`  ${REFRESH_HINT}`)
  }

  if (failures > 0) {
    stderr(`${failures} of ${targets.length} install(s) failed`)
    process.exitCode = 1
  }
}

/**
 * 参数二义性判定:本地 tarball 还是市场 id。
 *
 * 市场 id 是裸标识符(`tps-meter`),路径几乎总带 `/`、`.tgz` 或 `./`。
 * `@` 开头的一律当包名而不是路径 —— `@onething-plugins/foo` 里的斜杠是 scope
 * 分隔符,不是目录分隔符。
 */
function looksLikeLocalTarball(target: string): boolean {
  const trimmed = target.trim()
  if (!trimmed || trimmed.startsWith('@')) return false
  if (/\.tgz$/i.test(trimmed)) return true
  if (trimmed.includes('/') || trimmed.includes(path.sep)) return true
  if (trimmed.startsWith('.') || trimmed.startsWith('~')) return true
  try {
    return fs.statSync(trimmed).isFile()
  } catch {
    return false
  }
}

/**
 * 市场索引:桌面装配期在 main-process.ts 注入同一条 URL,CLI 进程里没人注入过,
 * 所以这里自己配一次(import 的是同一个常量,不抄字面量)。
 */
async function fetchMarketIndex(): Promise<CorePluginMarketIndex | null> {
  configurePluginMarketIndex(PLUGIN_MARKET_INDEX_URL)
  const snapshot = await getPluginMarketIndexSnapshot({ refresh: true })
  if (!snapshot.index && snapshot.error) stderr(`Market index fetch failed: ${snapshot.error}`)
  return snapshot.index
}

// ── list ──

async function listPlugins(): Promise<void> {
  const ledger = await readLedger(resolvePluginsDir())
  if (ledger.entries.length === 0) {
    stdout('(none) — no plugin is installed through the npm ledger')
    return
  }
  printRows(
    ledger.entries.map(entry => ({
      id: unscopedPluginIdFromPackageName(entry.name),
      pkg: entry.name,
      spec: entry.spec,
    })),
    ['id', 'pkg', 'spec'],
  )
}

// ── uninstall ──

async function uninstallPlugin(target: string | undefined): Promise<void> {
  const wanted = (target ?? '').trim()
  if (!wanted) throw new Error('plugin uninstall requires a plugin id or package name')

  const pluginsDir = resolvePluginsDir()
  const ledger = await readLedger(pluginsDir)
  const names = ledger.entries.map(entry => entry.name)
  // 完整包名直查 → 补 scope 前缀试探 → 账里某条去 scope 后相等(别的 scope 装的)。
  const pkg = names.find(name => name === wanted)
    ?? names.find(name => name === `${PLUGIN_PACKAGE_SCOPE}/${wanted}`)
    ?? names.find(name => /^@[^/]+\//.test(name) && name.replace(/^@[^/]+\//, '') === wanted)
  if (!pkg) {
    throw new Error(
      `"${wanted}" is not in the plugin ledger. `
      + (names.length > 0 ? `Installed: ${names.join(', ')}` : 'Nothing is installed.'),
    )
  }

  const result = await uninstallPluginPackage(pluginsDir, pkg)
  if (!result.removed) throw new Error(result.error ?? `npm uninstall failed for ${pkg}`)
  stdout(`✓ uninstalled ${pkg}`)
  stdout(`  ${REFRESH_HINT}`)
  // 数据家目录(plugins/<id>/)是 PluginManager 卸载链的活儿(归档);CLI 只拆账
  // 与代码,数据原样留在盘上 —— 说清楚,免得用户以为已经清干净了。
  stdout('  Its data directory was left untouched; uninstall from the desktop Settings page to archive it too.')
}

// ── 共用 ──

/** 账本读不可信(坏 JSON / 读不动)时不能当空账用 —— 那会把"什么都没装"当事实。 */
async function readLedger(pluginsDir: string): Promise<{ entries: Array<{ name: string; spec: string }> }> {
  const ledger = readPluginLedger(pluginsDir)
  if (!ledger.trusted) throw new Error(ledger.reason ?? `cannot read the plugin ledger in ${pluginsDir}`)
  return { entries: ledger.entries }
}

function resolvePluginsDir(): string {
  return getPluginsDir()
}

/** index.ts 的 printRows 同形;那边顶层就跑 main(),import 不得,只能同形一份。 */
function printRows(rows: Array<Record<string, string>>, columns: string[]): void {
  const widths = columns.map(column => Math.max(
    column.length,
    ...rows.map(row => String(row[column] ?? '').length),
  ))
  stdout(columns.map((column, i) => column.padEnd(widths[i])).join('  '))
  for (const row of rows) {
    stdout(columns.map((column, i) => String(row[column] ?? '').padEnd(widths[i])).join('  '))
  }
}
