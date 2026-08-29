/**
 * 崩溃捕获 —— 把「没人接住的错」也变成日志中枢里的一条记录。
 *
 * 三个产地,一个落点:
 *  · `window.onerror`        —— 同步抛出的、没被任何 try 接住的错;
 *  · `unhandledrejection`    —— 没有 .catch 的 Promise;
 *  · `<ErrorBoundary>`       —— React 渲染期炸掉的子树(边界自己调 `recordCrash`)。
 *
 * 它**不接管** console.error:那是日志中枢自己的镜像出口(services/log.ts),
 * 在这里再包一层只会让同一句话记两遍。
 *
 * 环缓冲与日志共用一份(`services/log.ts` 的那个 ring)—— 崩的那一刻前面 200 条
 * 说了什么,才是排障要看的东西;单独开一条崩溃环会把因果切成两半。
 * `window.__crash.dump()` 因此只是「按 ns 前缀筛过的 `window.__log.dump()`」。
 */
import { dumpLog, record, type LogRecord } from './log'

/** 崩溃记录统一挂这个 ns 前缀 —— dump 就是按它筛。 */
export const CRASH_NS_PREFIX = 'crash'

export type CrashSource = 'window.onerror' | 'unhandledrejection' | 'boundary'

/** 把任意抛出物压成 `{message, stack}`。抛字符串、抛对象、抛 undefined 都得接住。 */
export function describeThrown(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, stack: value.stack }
  if (typeof value === 'string') return { message: value }
  try {
    return { message: JSON.stringify(value) ?? String(value) }
  } catch {
    return { message: String(value) }
  }
}

/**
 * 记一次崩溃。`where` 是人话的现场名(面板 id / 'chat' / 'composer'),
 * 错误卡上显示的就是它 —— 「哪错了」那一要素靠这个字段兑现。
 */
export function recordCrash(source: CrashSource, where: string, thrown: unknown, extra?: unknown): void {
  const { message, stack } = describeThrown(thrown)
  record('error', `${CRASH_NS_PREFIX}.${source}`, message, [
    { where, stack: stack?.split('\n').slice(0, 6).join('\n') },
    ...(extra === undefined ? [] : [extra]),
  ])
}

/** 崩溃现场 = 日志环里 ns 以 `crash.` 打头的那些条。 */
export function dumpCrashes(): LogRecord[] {
  return dumpLog().filter((r) => r.ns.startsWith(`${CRASH_NS_PREFIX}.`))
}

declare global {
  interface Window {
    __crash?: { dump: () => LogRecord[] }
  }
}

let installed = false

/**
 * 装监听。幂等 —— HMR 重跑模块、测试重复调用都不该叠出第二份监听。
 * 返回一个卸载函数,测试用它把环境还原干净。
 */
export function installCrashHandlers(): () => void {
  if (typeof window === 'undefined') return () => undefined
  window.__crash = { dump: dumpCrashes }
  if (installed) return () => undefined
  installed = true

  const onError = (event: ErrorEvent) => {
    // 有 error 对象就用它(带 stack);只有 message 的跨域脚本错就记 message。
    recordCrash('window.onerror', event.filename || 'window', event.error ?? event.message, {
      line: event.lineno,
      col: event.colno,
    })
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    recordCrash('unhandledrejection', 'promise', event.reason)
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    installed = false
  }
}
