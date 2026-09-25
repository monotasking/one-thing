/**
 * Electron 进程探针:把 `app.getAppMetrics()` 转换为内存报告中的进程行。
 *
 * 主进程的探针只能测量自身;渲染进程、GPU、网络服务和内置浏览器的每个标签页
 * 都是独立进程,由这里报告。Electron 接口通过参数注入,本文件不直接引用 electron。
 */
import type { MemoryProcessKind, MemoryProcessProbe, MemoryProcessSample } from '@onething/core/memory'

/** `Electron.ProcessMetric` 中用到的字段(单位 KiB)。 */
export interface ShellProcessMetric {
  pid: number
  type: string
  name?: string
  serviceName?: string
  memory?: { workingSetSize?: number; privateBytes?: number }
}

/** 渲染进程的归属:应用窗口(`shell`)或内置浏览器标签页(`browser`),以及标题。 */
export interface ShellWebContentsInfo {
  pid: number
  role: 'shell' | 'browser'
  title: string
  /** 该进程属于页面中的跨站子框架。 */
  subframe?: boolean
}

export interface ShellMemoryProbeDeps {
  getAppMetrics(): ShellProcessMetric[]
  listWebContents(): ShellWebContentsInfo[]
  /** 主进程 pid,已由主进程探针报告,这里跳过。 */
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

/** 转换 `getAppMetrics()` 的结果。优先使用私有字节(仅 Windows 提供),否则用工作集。 */
export function toMemoryProcessSamples(
  metrics: readonly ShellProcessMetric[],
  webContents: readonly ShellWebContentsInfo[],
  selfPid: number,
): MemoryProcessSample[] {
  // 同一 pid 同时出现在主框架和子框架中时,按主框架命名。
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
