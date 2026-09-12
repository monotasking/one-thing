/**
 * CDP(`--remote-debugging-port`)开关的**启动旗文件**(方案 §9-4)。
 *
 * ## 为什么是旗文件,而不是读设置
 *
 * `--remote-debugging-port` 是 `app.commandLine.appendSwitch`,**只能在 app `ready`
 * 之前**加;而设置是装配之后才读得到的(装配本身发生在 ready 之后)。两件事在
 * 时间上永远碰不到头。
 *
 * 所以设置域写开关的时候顺手落一个 `<store>/run/cdp.json`(与 `run/http.json` 同族
 * ——运行期瞬时文件,0600),主进程在 ready 之前**读盘**。它不是第二个设置读者:
 * 它是那一格设置的**启动期投影**,和发现文件一样。行上因此要写明「重启生效」。
 *
 * ## argv 已经带了就不再 append(这一条不加,真机门会被产品旗子顶掉)
 *
 * `gate-packaged.mjs` 起 app 时自己带 `--remote-debugging-port=<门自己的端口>`。
 * Chromium 同名开关**后写的盖前写的**,所以产品这边无脑 append 会把门的端口顶掉,
 * 门连不上、报一句看起来毫不相干的话。判据一句:argv 里已经有了就让开。
 *
 * ## 缺省关(拍点 ②,用户已按推荐拍定)
 *
 * 开着 = 本机任何进程都能驱动一个登着谷歌的浏览器;而且 CDP 口一开,**壳自己的
 * 渲染页也是一个 page 目标**,它内存里有 `host:connection` 交来的 Bearer token
 * (§9-13)。与 0600 的 `run/http.json` 同一信任级(本机同用户),不新增一类暴露
 * ——但不是理由把它默认打开。
 *
 * 这只文件全是纯函数 + 一次读盘:零 electron import,`app` 是注入的端口。
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getOnethingRunDir } from '@onething/runtime/storage'
import type { ChromiumApp } from './user-agent.js'

export const CDP_FLAG_FILENAME = 'cdp.json'

/** 只监听回环 —— 一个绑 0.0.0.0 的调试口等于把这台浏览器挂到局域网上。 */
export const CDP_ADDRESS = '127.0.0.1'

export interface CdpLaunchFlag {
  readonly port: number
}

export function getCdpFlagPath(storePath?: string): string {
  return path.join(getOnethingRunDir(storePath ? { storePath } : {}), CDP_FLAG_FILENAME)
}

/**
 * 读旗文件。**缺席 / 坏 JSON / 端口不合法 一律答 `undefined`**,不抛 ——
 * 它跑在 ready 之前,这里抛一下就是整个 app 起不来,而这一格的全部后果只是
 * 「CDP 没开」。端口范围按 Chromium 自己的口径:1..65535,且 `0`(= 随机口)
 * 不收 —— 随机口没人发现得了,等于开了个谁都用不上的洞。
 */
export function readCdpLaunchFlag(storePath?: string): CdpLaunchFlag | undefined {
  let raw: string
  try {
    raw = readFileSync(getCdpFlagPath(storePath), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const port = (parsed as { port?: unknown }).port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { port }
}

/**
 * 写(或删)旗文件。设置域在用户改那一格开关时调;`null` = 关掉。
 *
 * 0600 + 0700 的目录,与发现文件同档:这个文件说的是「这台机器上哪个端口能驱动
 * 一个登着账号的浏览器」,不该让同机别的用户读到。
 */
export function writeCdpLaunchFlag(storePath: string | undefined, flag: CdpLaunchFlag | null): void {
  const filePath = getCdpFlagPath(storePath)
  if (!flag) {
    rmSync(filePath, { force: true })
    return
  }
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${JSON.stringify(flag, null, 2)}\n`, { mode: 0o600 })
  try {
    // mode 只在**创建**时生效(上一次没删干净时 writeFileSync 不改权限)。
    chmodSync(filePath, 0o600)
  } catch {
    /* 只读文件系统等边缘情况:权限收不紧不该让这一格失败。 */
  }
}

/** argv 上有没有已经带着这个开关(门自己带的那一份)。 */
export function argvHasCdpFlag(argv: readonly string[] = process.argv): boolean {
  return argv.some(arg => arg === '--remote-debugging-port' || arg.startsWith('--remote-debugging-port='))
}

/**
 * 把旗文件落成 Chromium 开关。**必须在 app `ready` 之前**调。
 *
 * 返回真正 append 了没有 —— 调用方拿它记一行日志(「CDP 开在 9222」是排障时最想
 * 先看见的一句),也让测试有东西可断言。
 */
export function applyCdpFlag(
  app: ChromiumApp,
  flag: CdpLaunchFlag | undefined,
  argv: readonly string[] = process.argv,
): boolean {
  if (!flag) return false
  // 两道判据,两个产地:argv 是门自己带进来的,`hasSwitch` 是这个进程里别处
  // 已经 append 过的。任一命中就让开 —— 后写的会盖掉先写的。
  if (argvHasCdpFlag(argv) || app.commandLine.hasSwitch('remote-debugging-port')) return false
  app.commandLine.appendSwitch('remote-debugging-port', String(flag.port))
  app.commandLine.appendSwitch('remote-debugging-address', CDP_ADDRESS)
  return true
}
