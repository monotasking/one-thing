import { app, type WebContents } from 'electron'
import { RENDERER_LOG_ECHO_MARK } from '@shared/ipc/logs.js'

/**
 * Electron 侧的 renderer **兜底**采集(拍板 C②)。
 *
 * L3 之前 renderer 没有自己的日志通路,只能靠 `console-message` 顺带落盘;
 * 那条路把 app.log 的 38% 灌成了 Vue warn 的组件链栈(每条多行、每行一条记录)。
 * 这里做三件事把它降级成"兜底":
 *  1. **只抓 warn+** —— info/debug 的 renderer 噪音不再进主进程日志;
 *  2. **结构化** —— `fields {webContentsId, sourceId, lineNumber, url}`,不再把
 *     元数据拼进消息字符串;
 *  3. **多行折叠** —— Vue warn 的组件链栈折成**一条**记录,首行是 msg,
 *     其余进 `fields.stack`;
 *  4. **认自己的回声**(L3)—— RendererLogHub 在 dev 下会把记录回显到 console,
 *     warn/error 的回显同样是 warn+,不滤掉就会同一条落两遍。回显行一律带零宽
 *     标记 `RENDERER_LOG_ECHO_MARK`,这里见到就丢:那条记录**已经**经 hub 的
 *     `logs.append` 上行了,兜底不该再抄一遍。
 */

export type ElectronAppLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 与 `@onething/backend/logging` 的 `RendererCaptureLogEntry` 对齐。 */
export interface ElectronAppLogEntry {
  level: ElectronAppLogLevel
  /** 命名空间;renderer 兜底一律 `renderer`。 */
  ns?: string
  msg: string
  fields?: Record<string, unknown>
  /** 旧口径标签 `renderer:<wcId>`,装配层把它放进 `fields.source`。 */
  source?: string
}

export interface ElectronLoggingAppLike {
  setAppLogsPath(path: string): void
  on(event: 'web-contents-created', listener: (event: unknown, webContents: ElectronLoggingWebContents) => void): void
  off(event: 'web-contents-created', listener: (event: unknown, webContents: ElectronLoggingWebContents) => void): void
}

export interface ElectronLoggingWebContents {
  id: number
  getURL(): string
  on(event: 'console-message', listener: (
    event: unknown,
    legacyLevel: number,
    legacyMessage: string,
    legacyLine: number,
    legacySourceId: string,
  ) => void): void
}

export interface ElectronRendererConsoleCaptureOptions {
  log(entry: ElectronAppLogEntry): void
  app?: ElectronLoggingAppLike
}

export interface ElectronRendererConsoleCapture {
  attach(): void
  detach(): void
  attachWebContentsLogging(webContents: ElectronLoggingWebContents): void
}

const NUMERIC_RENDERER_LEVELS: Record<number, ElectronAppLogLevel> = {
  0: 'debug',
  1: 'info',
  2: 'warn',
  3: 'error',
}

const STRING_RENDERER_LEVELS: Record<string, ElectronAppLogLevel> = {
  debug: 'debug',
  info: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
}

/** 兜底只收 warn 及以上。 */
const CAPTURED_LEVELS = new Set<ElectronAppLogLevel>(['warn', 'error'])

/** 首行是消息,其余(组件链 / 栈)折进一个字段。 */
export function splitRendererMessage(message: string): { msg: string; stack?: string } {
  const normalized = message.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const newline = normalized.indexOf('\n')
  if (newline === -1) return { msg: normalized.trim() }
  const msg = normalized.slice(0, newline).trim()
  const stack = normalized.slice(newline + 1).trim()
  return stack ? { msg, stack } : { msg }
}

export function setElectronAppLogsPath(logDir: string, electronApp: Pick<ElectronLoggingAppLike, 'setAppLogsPath'> = app): void {
  electronApp.setAppLogsPath(logDir)
}

export function createElectronRendererConsoleCapture(
  options: ElectronRendererConsoleCaptureOptions,
): ElectronRendererConsoleCapture {
  const electronApp = options.app ?? app
  const attachedWebContents = new WeakSet<ElectronLoggingWebContents>()
  let webContentsCreatedHandler: ((event: unknown, webContents: ElectronLoggingWebContents) => void) | null = null

  function attachWebContentsLogging(webContents: ElectronLoggingWebContents): void {
    if (attachedWebContents.has(webContents)) return
    attachedWebContents.add(webContents)

    webContents.on('console-message', (event, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
      const details = event as {
        level?: string
        message?: string
        lineNumber?: number
        sourceId?: string
      }
      const message = typeof details.message === 'string' ? details.message : legacyMessage
      if (!message) return
      // hub 的回声 —— 它自己已经上行过了(见文件头第 4 条)。
      if (message.startsWith(RENDERER_LOG_ECHO_MARK)) return

      const rawLevel = typeof details.level === 'string' ? details.level : legacyLevel
      const level = typeof rawLevel === 'number'
        ? NUMERIC_RENDERER_LEVELS[rawLevel] ?? 'info'
        : STRING_RENDERER_LEVELS[rawLevel] ?? 'info'
      if (!CAPTURED_LEVELS.has(level)) return

      const lineNumber = typeof details.lineNumber === 'number' ? details.lineNumber : legacyLine
      const sourceId = details.sourceId || legacySourceId
      const { msg, stack } = splitRendererMessage(message)

      options.log({
        level,
        ns: 'renderer',
        source: `renderer:${webContents.id}`,
        msg,
        fields: {
          webContentsId: webContents.id,
          ...(sourceId ? { sourceId } : {}),
          ...(lineNumber ? { lineNumber } : {}),
          url: webContents.getURL(),
          ...(stack ? { stack } : {}),
        },
      })
    })
  }

  return {
    attach(): void {
      if (webContentsCreatedHandler) return
      webContentsCreatedHandler = (_event, webContents) => attachWebContentsLogging(webContents)
      electronApp.on('web-contents-created', webContentsCreatedHandler)
    },
    detach(): void {
      if (!webContentsCreatedHandler) return
      electronApp.off('web-contents-created', webContentsCreatedHandler)
      webContentsCreatedHandler = null
    },
    attachWebContentsLogging,
  }
}

export type ElectronWebContents = WebContents
