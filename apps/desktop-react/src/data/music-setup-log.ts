import { create } from 'zustand'

/**
 * **装工具时那条命令吐出来的字**(接入向导 §6.3 第 ① 步)。
 *
 * ── 为什么它不是一条 query ──────────────────────────────────────────────
 * query 的判据是「这件事重做一遍是不是无害的」——而这块输出**问不回来**:它是
 * `npm install` / `brew install` 在跑的那几十秒里一行一行推出来的,后端不留、
 * 也没有一条读法答得出「刚才那条命令说了什么」。它是推来的进度,不是可重读的
 * 答案,所以它住在自己这一格小账上,由 `music-source` 收到 `setupOutput` 那条
 * 资源事实时往里塞。
 *
 * ── 它不是账本,是屏幕 ──────────────────────────────────────────────────
 * 关掉面板就没了,这是对的:没人在看的时候,一段安装日志没有任何用处。所以
 * 这里既不落盘也不进 query 缓存,`resetMusicSource()` 顺手把它清空。
 *
 * 环大小 200 行:屏上只画最后十几行(§6.3「最多 12 行、自动跟到底」),留出
 * 的余量是给人往回滚一小段看错误的 —— npm 的失败原因常常在末尾往上第五六行。
 */

/** 留在内存里的行数上限。屏上画多少由那块面自己说(它有自己的高度)。 */
export const INSTALL_LOG_LINES = 200

interface InstallLogState {
  /** 工具 id → 它这一次安装到目前为止的那些行。 */
  readonly byTool: Readonly<Record<string, readonly string[]>>
}

export const useInstallLog = create<InstallLogState>()(() => ({ byTool: {} }))

/**
 * 把一块新到的输出并进去,**纯函数**(单测直接判它,不必去摆一台 store)。
 *
 * 一块 chunk 不保证按行到达 —— 子进程的管道是按字节切的,一行可能被劈成两半。
 * 所以**最后一行是接着写的**:上一块没有以换行收尾时,新来的头一段续在它屁股
 * 后面,而不是另起一行。不这么做的话 `added 87 packages` 会在屏上碎成三行。
 */
export function appendInstallLines(
  previous: readonly string[],
  chunk: string,
  limit = INSTALL_LOG_LINES,
): readonly string[] {
  if (!chunk) return previous
  // `\r` 是进度条在原地重画自己(npm / brew 都这么干)。屏上没有「原地」,
  // 所以当换行处理 —— 让每一次重画各占一行,总比把整条进度条挤成一行乱码好。
  const parts = chunk.replace(/\r\n?/g, '\n').split('\n')
  const lines = [...previous]
  const head = parts.shift() ?? ''
  if (lines.length === 0) lines.push(head)
  else lines[lines.length - 1] = `${lines[lines.length - 1]}${head}`
  for (const part of parts) lines.push(part)
  return lines.length > limit ? lines.slice(lines.length - limit) : lines
}

export function appendInstallOutput(tool: string, chunk: string): void {
  if (!tool) return
  useInstallLog.setState((state) => ({
    byTool: { ...state.byTool, [tool]: appendInstallLines(state.byTool[tool] ?? [], chunk) },
  }))
}

/** 重新开一次安装:上一次的输出(尤其是失败那一段)不该留在新的一次上面。 */
export function clearInstallOutput(tool: string): void {
  useInstallLog.setState((state) => {
    if (!(tool in state.byTool)) return state
    const byTool = { ...state.byTool }
    delete byTool[tool]
    return { byTool }
  })
}

/** 回到出厂。`resetMusicSource()` 与 HMR 走的是这一口。 */
export function resetInstallLog(): void {
  useInstallLog.setState({ byTool: {} })
}
