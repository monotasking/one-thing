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
import { notify } from './notify'
import { t } from '../i18n'

/** 崩溃记录统一挂这个 ns 前缀 —— dump 就是按它筛。 */
export const CRASH_NS_PREFIX = 'crash'

/**
 * 同一个现场的崩溃在这段时间内合并成一条(次数记在 count 上)。
 *
 * 一个渲染错常常每帧抛一次:不合并的话,60 秒能把 200 条通知环冲干净,
 * 屏幕上还会摞满一样的 toast。合并的键是 `source + title`,而 title 里带着
 * 现场名(哪块面板),所以两块不同的面板同时炸掉仍然是两条 —— 合的是重复,
 * 不是「所有的错」。
 */
export const CRASH_DEDUPE_MS = 60_000

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
 * 现场名的**短名**:给人看的那一版。
 *
 * `where` 有两种来路,而只有一种是人话:
 *  · 边界与手写调用点给的是现场 id('chat' / 'files' / 'composer')—— 本来就是人话;
 *  · `window.onerror` 给的是 `event.filename`,那是一条**完整模块 URL**
 *    (`http://localhost:5199/src/components/DockTile.tsx?t=1756612345678`)。
 *
 * 把后者原样摆到弹框标题上,是把给机器看的东西当人话用(09-01 报障):它长到
 * 顶穿容器,而它多出来的那些字节(协议、端口、HMR 时间戳)一个都不帮人回答
 * 「哪儿坏了」。取末段、去 query,`DockTile.tsx` 才是那句话里有用的部分。
 *
 * **去掉 `?t=` 还顺手治好了风暴合并**:去重的键是 source + title,而 HMR 每次
 * 重载都换一个时间戳 —— 短名之前,同一个错连炸五次是五个互不相同的标题,
 * 五条记录五个框;短名之后它们是同一条,合并成一条带计数(见 services/notify.ts)。
 *
 * 完整那条不丢,它进详情(见下面 recordCrash 的 detail)。
 */
export function shortWhere(where: string): string {
  const withoutQuery = where.split(/[?#]/)[0]
  const last = withoutQuery.split('/').filter(Boolean).pop()
  return last || where
}

/**
 * 记一次崩溃。`where` 是现场(面板 id / 'chat' / 'composer' / 出错模块的 URL),
 * 错误卡上显示的是它的**短名** —— 「哪错了」那一要素靠这个字段兑现。
 *
 * 日志环收的仍然是**原样的** where(排障要的是那条完整 URL,连 HMR 时间戳都要),
 * 屏幕上收的是短名 —— 同一件事的两面,各给各的读者。
 */
export function recordCrash(source: CrashSource, where: string, thrown: unknown, extra?: unknown): void {
  const { message, stack } = describeThrown(thrown)
  const head = stack?.split('\n').slice(0, 6).join('\n')
  record('error', `${CRASH_NS_PREFIX}.${source}`, message, [
    { where, stack: head },
    ...(extra === undefined ? [] : [extra]),
  ])
  const short = shortWhere(where)
  // 日志环是给排障的人看的,用户看不到它。崩溃是**用户该知道**的那一类,
  // 所以同一件事还要往通知走一趟 —— 两条路各记各的那一面(notify 不写日志环)。
  notify({
    level: 'error',
    source: `${CRASH_NS_PREFIX}.${source}`,
    title: t('notify.crash', { where: short }),
    // 正文是**那句错**(「TypeError: 读不到 undefined 的 tile」)—— 它一行就说清了
    // 「什么坏了」,是这条通知里最该被人看见的一句,所以它留在面上。
    // 收进详情的是给机器看的那两样:完整 URL 与栈。
    body: message,
    // 栈的第一行**就是**那句 message,所以有栈时详情就是栈,不再把 message 抄在它上面
    // (真机上看到过一次「Error: delta / Error: delta / at …」的重复,就是这么来的)。
    // 短名把 where 削掉了一截,削掉的那一截在这里补回来:详情是**全量**的那一份。
    detail: [short === where ? null : where, head || message].filter(Boolean).join('\n'),
    dedupeMs: CRASH_DEDUPE_MS,
  })
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
