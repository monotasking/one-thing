/**
 * 壳在内存预算表上的那只进程探针(2026-09-25)。
 *
 * core 自己那只探针只量得到本进程(`process.memoryUsage().rss`);活动监视器里看到的
 * 「接近 2G」是整个 Electron 的和 —— 渲染进程、GPU、网络服务、内置浏览器的每一格
 * tab 各是一个进程。这只探针把 `app.getAppMetrics()` 折成表上的行。
 *
 * 纯函数 + 注入的 electron 面,所以它在 vitest 下能跑(只有 `main.ts` import electron)。
 * 这个文件取代了从前那份 `memory-protocol.ts`:它画了一条 `host:memory` 的 IPC 通道,
 * 但一行实现都没有 —— 而壳的 `ipcMain` 被 `transport:gate` 钉在 ≤ 2;读数改走通用
 * RPC 的 `memory` 域,不需要第三条通道。
 */
import type { MemoryProcessKind, MemoryProcessProbe, MemoryProcessSample } from '@onething/core/memory'

/** `Electron.ProcessMetric` 里用得到的那几格(字节以 KiB 给出)。 */
export interface ShellProcessMetric {
  pid: number
  type: string
  name?: string
  serviceName?: string
  memory?: { workingSetSize?: number; privateBytes?: number }
}

/** 一只渲染进程是谁:壳自己的窗(`shell`)还是内置浏览器的一格(`browser`),带标题。 */
export interface ShellWebContentsInfo {
  pid: number
  role: 'shell' | 'browser'
  title: string
  /** 这一行来自页里的子框架(跨站 iframe 被站点隔离进了自己的进程)。 */
  subframe?: boolean
}

export interface ShellMemoryProbeDeps {
  getAppMetrics(): ShellProcessMetric[]
  listWebContents(): ShellWebContentsInfo[]
  /** 本进程 pid —— core 那只探针已经报过,这里跳过,免得算两遍。 */
  selfPid: number
}

const TITLE_MAX = 80

function kindOf(metric: ShellProcessMetric, contents: ShellWebContentsInfo | undefined): MemoryProcessKind {
  switch (metric.type) {
    case 'Browser': return 'main'
    case 'Tab': return contents?.role === 'browser' ? 'browser' : 'renderer'
    case 'GPU': return 'gpu'
    case 'Utility': return 'utility'
    default: return 'other'
  }
}

function nameOf(metric: ShellProcessMetric, contents: ShellWebContentsInfo | undefined): string {
  const base = contents?.title || metric.serviceName || metric.name || metric.type
  const raw = contents?.subframe ? `${base} · 子框架` : base
  return raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX)}…` : raw
}

/** `getAppMetrics()` → 表上的行。私有字节(Windows 才有)优先于工作集。 */
export function toMemoryProcessSamples(
  metrics: readonly ShellProcessMetric[],
  webContents: readonly ShellWebContentsInfo[],
  selfPid: number,
): MemoryProcessSample[] {
  // 同一个 pid 可能既是某页的主进程又被别页的 iframe 复用:主框架那一行说了算。
  const byPid = new Map<number, ShellWebContentsInfo>()
  for (const info of webContents) {
    const known = byPid.get(info.pid)
    if (!known || (known.subframe && !info.subframe)) byPid.set(info.pid, info)
  }
  const rows: MemoryProcessSample[] = []
  for (const metric of metrics) {
    if (metric.pid === selfPid) continue
    const contents = byPid.get(metric.pid)
    const kib = metric.memory?.privateBytes || metric.memory?.workingSetSize
    rows.push({
      pid: metric.pid,
      kind: kindOf(metric, contents),
      name: nameOf(metric, contents),
      bytes: typeof kib === 'number' && kib > 0 ? kib * 1024 : null,
    })
  }
  return rows
}

export function createShellMemoryProbe(deps: ShellMemoryProbeDeps): MemoryProcessProbe {
  return {
    id: 'process.electron',
    sample: () => toMemoryProcessSamples(deps.getAppMetrics(), deps.listWebContents(), deps.selfPid),
  }
}
