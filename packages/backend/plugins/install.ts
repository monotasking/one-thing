/**
 * P1:npm 生命周期 —— runtime 适配层。
 *
 * core 的 install.ts 只编排;这里供 npm 机制本身:spawn(Windows 的
 * npm.cmd、120s 预算、SIGKILL、stderr 留尾),以及市场索引的拉取
 * (P1 未配 URL = 更新通道关闭,P3 接设置页)。
 */
import { spawn } from 'child_process'
import path from 'path'
import {
  installCorePluginPackage,
  readPluginLedgerSpec,
  uninstallCorePluginPackage,
  type CorePluginMarketIndex,
  type InstallCorePluginPackageInput,
  type InstallCorePluginPackageResult,
} from '@onething/core/plugins'
import { PLUGIN_NPM_INSTALL_TIMEOUT_MS } from './loader.js'
import { consolePort, getLogger } from '../wiring/logging/index.js'

const log = getLogger('plugins.market')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * npm 可用性探测(裁决 8:v1 依赖本机 npm)—— 设置页据此把 Install/Update
 * 置灰并说明,而不是点了才炸。`npm --version` 轻量且缓存:能力面在一个
 * 进程生命周期内不会变。
 */
let npmAvailability: Promise<boolean> | null = null

export function probePluginNpmAvailability(): Promise<boolean> {
  if (!npmAvailability) {
    npmAvailability = new Promise<boolean>(resolve => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(NPM_BIN, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] })
      } catch {
        resolve(false)
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(false)
      }, 5_000)
      timer.unref?.()
      child.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })
  }
  return npmAvailability
}

/**
 * 跑 npm,返回退出码与 stderr 尾部。
 *
 * 不 reject:安装链要自己看退出码决定回滚,异常形态留给"进程根本没起来"。
 * stdout 留 'ignore'(话多的脚本写满管道缓冲会堵死 npm 自己,被误判超时)。
 */
export function runPluginNpm(args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NPM_BIN, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGKILL')
      resolve({ code: 124, stderr: `npm ${args[0]} timed out after ${PLUGIN_NPM_INSTALL_TIMEOUT_MS}ms` })
    }, PLUGIN_NPM_INSTALL_TIMEOUT_MS)
    timer.unref?.()

    child.stderr?.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-8_000)
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 1, stderr })
    })
  })
}

/** host 端口:装/更新一个包(脚手架、--ignore-scripts、装后校验、回滚全在 core 编排里)。 */
export function installPluginPackage(
  pluginsDir: string,
  input: InstallCorePluginPackageInput,
): Promise<InstallCorePluginPackageResult> {
  return installCorePluginPackage(pluginsDir, input, { runNpm: runPluginNpm, logger: consoleLog })
}

/** host 端口:读账本里某包当前 spec(update 回滚旧版用)。 */
export function readInstalledPluginSpec(pluginsDir: string, pkg: string): string | undefined {
  return readPluginLedgerSpec(pluginsDir, pkg)
}

/** host 端口:npm 形态卸载 = `npm uninstall`(legacy 目录插件仍走 rm,见 manager 的分支)。 */
export function uninstallPluginPackage(
  pluginsDir: string,
  pkg: string,
): Promise<{ removed: boolean; error?: string }> {
  return uninstallCorePluginPackage(pluginsDir, pkg, { runNpm: runPluginNpm, logger: consoleLog })
}

/** definition.dirPath(node_modules/<pkg>)→ 包名(含可能的 scope)。 */
export function packageNameFromNodeModulesPath(pluginsDir: string, dirPath: string): string | null {
  const relative = path.relative(path.join(pluginsDir, 'node_modules'), path.resolve(dirPath))
  if (!relative || relative.startsWith('..')) return null
  // scoped 包是两层目录(@org/foo),非 scoped 一层。
  const parts = relative.split(path.sep)
  if (parts[0]?.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`
  return parts[0] ?? null
}

// ── 市场索引拉取 ──

let marketIndexUrl: string | null = null
/** 上次成功拉取的索引缓存(P3:断网时市场区显示上次缓存 + 明示过期)。 */
let marketIndexCache: { at: number; index: CorePluginMarketIndex } | null = null
/** 上次拉取失败时刻 —— stale 判定:failureAt > cache.at 说明缓存已过期。 */
let marketIndexLastFailureAt: number | null = null

/** P1:市场索引 URL 由宿主装配期注入(未配置 = 更新通道关闭);P3 接设置页。 */
export function configurePluginMarketIndex(url: string | null): void {
  marketIndexUrl = url
  if (!url) marketIndexCache = null
}

/** 测试用:直接塞一份索引当"拉取成功",不起网络。 */
export function setPluginMarketIndexForTest(index: CorePluginMarketIndex | null): void {
  marketIndexCache = index ? { at: Date.now(), index } : null
  marketIndexLastFailureAt = null
  if (index) marketIndexUrl = marketIndexUrl ?? 'test://market'
}

function isMarketIndexShape(value: unknown): value is CorePluginMarketIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const index = value as { version?: unknown; plugins?: unknown }
  if (typeof index.version !== 'number' || !Array.isArray(index.plugins)) return false
  return index.plugins.every(entry => entry && typeof entry === 'object'
    && typeof (entry as { id?: unknown }).id === 'string'
    && typeof (entry as { pkg?: unknown }).pkg === 'string'
    && typeof (entry as { version?: unknown }).version === 'string'
    && typeof (entry as { tarballUrl?: unknown }).tarballUrl === 'string')
}

async function fetchFreshMarketIndex(): Promise<CorePluginMarketIndex> {
  const response = await fetch(marketIndexUrl!, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (!isMarketIndexShape(body)) throw new Error('unexpected index shape')
  return body
}

/**
 * host 端口(更新通道):未配置/拉取失败/形状不对 = null(失败时用上次缓存)。
 *
 * 永远先试拉新(refresh:true)—— P3 把缓存优先引进快照时,这条端口一度
 * 也变成缓存优先:设置页 10:00 拉过一次,10:25 的 updatePlugin 会拿十分钟
 * 前的索引说"没有更新"。缓存只配做**拉取失败的兜底**,不配做更新通道的
 * 情报来源。
 */
export async function fetchPluginMarketIndex(): Promise<CorePluginMarketIndex | null> {
  const snapshot = await getPluginMarketIndexSnapshot({ refresh: true })
  return snapshot.index
}

/**
 * P3 市场区视图用的快照:比 host 端口多带缓存龄与过期标记。
 *
 * stale 语义:本次想拉拉不到、展示的是上次缓存 —— 设置页据此明示
 * "上次更新于 X,可能是旧货",而不是让市场区在断网时直接消失。
 */
export async function getPluginMarketIndexSnapshot(input?: { refresh?: boolean }): Promise<{
  index: CorePluginMarketIndex | null
  fetchedAt: number | null
  stale: boolean
  error: string | null
}> {
  if (!marketIndexUrl) {
    return { index: null, fetchedAt: null, stale: false, error: 'market index URL is not configured' }
  }
  // 非强制刷新且有缓存:先用缓存(启动时设置页秒开;后台刷新走 refresh:true)。
  if (!input?.refresh && marketIndexCache) {
    return {
      index: marketIndexCache.index,
      fetchedAt: marketIndexCache.at,
      stale: marketIndexLastFailureAt !== null && marketIndexLastFailureAt > marketIndexCache.at,
      error: null,
    }
  }
  try {
    const index = await fetchFreshMarketIndex()
    marketIndexCache = { at: Date.now(), index }
    return { index, fetchedAt: marketIndexCache.at, stale: false, error: null }
  } catch (error) {
    marketIndexLastFailureAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    log.warn(
      'fetch plugin market index failed',
      { url: marketIndexUrl, reason: message },
    )
    // 缓存兜底时把失败原因一并给出 —— UI 可以说"为什么过期",
    // 而不是一律猜成断网。
    return {
      index: marketIndexCache?.index ?? null,
      fetchedAt: marketIndexCache?.at ?? null,
      stale: marketIndexCache !== null,
      error: message,
    }
  }
}
