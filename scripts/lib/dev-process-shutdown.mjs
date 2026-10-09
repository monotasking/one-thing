/**
 * Longer than Backend's 8 s drain deadline; launchers must not cut it short.
 *
 * **这两个数是本轮唯一保留的行为变化**(工单 4 B2;裁定正本 §3):HEAD 上是
 * 1.2 s + 1.8 s 两段硬等,而后端自己的排空死线就是 8 s —— 比它短的宽限期
 * 意味着每一次 Ctrl-C 都在会话账本 flush 到一半时强杀。代价是 Ctrl-C 在真的
 * 有东西要收尾时慢几倍(收尾快的进程照旧秒退,这里是**上限**不是固定等待)。
 */
/**
 * 桌面宿主(Electron 主进程)收尾的上限,10-09 孤儿后端修复时按 `apps/desktop-react/electron/main.ts` 的
 * `shutdownBackend` 现算:先跑 `windowServiceStops`(内置浏览器拆除,实测约 3 秒),再 `backendProcess.stop()`
 * (SIGTERM 后等 `BACKEND_STOP_GRACE_MS` = 后端排空 8 秒 + 最后一段 1 秒 + 余量 2 秒 = 11 秒,还没退才 SIGKILL)。
 * 从前那一格是 7 秒,合起来 10 秒 —— 恰好等于从前那个 10 秒强杀,于是 Ctrl+C 时 Electron 常在半路被杀,它拉起的后端(`detached`)没人通知、成了孤儿。
 * 后端今天自己看着父进程(`packages/backend/backend-launcher.ts` 的 `startParentWatch`),正确性已经不靠这里;
 * 这几个数只是让「被强杀」少发生,所以每一层都比它里面那一层多 5 秒余量:
 */
export const DESKTOP_HOST_SHUTDOWN_UPPER_MS = 3_000 + 11_000
/** `electron:dev`(`dev-app.mjs`)等 Electron 自己收完尾的宽限:宿主上限 + 5 秒。 */
export const DEV_ELECTRON_SHUTDOWN_GRACE_MS = DESKTOP_HOST_SHUTDOWN_UPPER_MS + 5_000
/**
 * `bun run dev` 等每条泳道的宽限:要罩得住桌面泳道里的 `dev-app.mjs`(它等完 Electron 还要关 vite),
 * 所以是 Electron 那一层 + 5 秒。仍长于后端 8 秒的排空死线(上面那条判例不破)。
 */
export const DEV_SHUTDOWN_GRACE_MS = DEV_ELECTRON_SHUTDOWN_GRACE_MS + 5_000
/** 清扫上一个 dev runner 的宽限:它自己要等完泳道那一层,所以再多 5 秒(从前 15 秒对 10 秒,同一个关系)。 */
export const DEV_RUNNER_SHUTDOWN_GRACE_MS = DEV_SHUTDOWN_GRACE_MS + 5_000

/** Observe immediately after spawn: exit does not mean inherited stdio is closed. */
export function observeChildClose(child) {
  let result
  let error
  const promise = new Promise(resolve => {
    child.once('error', cause => { error = cause })
    child.once('close', (code, signal) => {
      result = { code, signal, error }
      resolve(result)
    })
  })
  return { promise, get result() { return result } }
}

async function settlesWithin(promise, durationMs) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), durationMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** One signal request and deadline per child; every caller receives the same promise. */
export function createChildShutdown({
  child,
  close = observeChildClose(child),
  graceMs = DEV_SHUTDOWN_GRACE_MS,
  sendSignal = signal => child.kill(signal),
  onTimeout = () => {},
}) {
  let stopping
  return {
    closed: close.promise,
    stop(signal = 'SIGTERM') {
      if (stopping) return stopping
      stopping = Promise.resolve().then(async () => {
        let timedOut = false
        let timeoutCallbackError
        const signalErrors = []
        // 我们**自己**请求过的信号。子进程死于其中之一 = 按计划死的,不是故障
        // (工单 4 A6:从前任何 `result.signal` 都判失败,于是 Ctrl-C —— 泳道给
        // 每个子进程发 SIGTERM、子进程照办死掉 —— 恒退 1)。
        const sentSignals = []
        const send = requested => {
          sentSignals.push(requested)
          try { sendSignal(requested) }
          catch (error) { if (error?.code !== 'ESRCH') signalErrors.push(error) }
        }
        if (!close.result) {
          send(signal)
          if (!await settlesWithin(close.promise, graceMs)) {
            timedOut = true
            try { onTimeout() }
            catch (error) { timeoutCallbackError = new Error('Shutdown timeout reporter failed', { cause: error }) }
            send('SIGKILL')
          }
        }
        // A forced stop is still a failure even if the eventual exit code is zero.
        // Never report completion while a child or its stdio remains open.
        const result = await close.promise
        return { ...result, error: result.error ?? timeoutCallbackError, timedOut, signalErrors, sentSignals }
      })
      return stopping
    },
  }
}

/**
 * Existing lane discovery supplies the fixed PID set. Never rescan during stop:
 * a process created later may belong to a replacement launcher.
 */
export async function stopPidSnapshot({
  pids,
  isAlive,
  sendSignal,
  signal = 'SIGTERM',
  graceMs = DEV_SHUTDOWN_GRACE_MS,
  onTimeout = () => {},
}) {
  const owned = [...new Set(pids)]
  const signalErrors = []
  const send = (pid, requested) => {
    try { sendSignal(pid, requested) }
    catch (error) { if (error?.code !== 'ESRCH') signalErrors.push(error) }
  }
  let pending = owned.filter(isAlive)
  for (const pid of pending) send(pid, signal)
  const deadline = Date.now() + graceMs
  while (pending.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
    pending = pending.filter(isAlive)
  }
  const timedOut = pending.length > 0
  let timeoutCallbackError
  if (timedOut) {
    try { onTimeout([...pending]) }
    catch (error) { timeoutCallbackError = new Error('Shutdown timeout reporter failed', { cause: error }) }
    for (const pid of pending) send(pid, 'SIGKILL')
    // Do not claim a successful stop or launch a replacement over a live writer.
    // 但这一等必须有底(工单 4 A6):SIGKILL 送不到不可中断睡眠里的进程,而无限
    // `while` 会把整条 dev 泳道挂死在一个不打印任何东西的循环里 —— 表现是「Ctrl-C
    // 之后终端再也不回来」,没有任何线索。复用同一份宽限期,超时如实抛。
    const killDeadline = Date.now() + graceMs
    while (pending.length && Date.now() < killDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      pending = pending.filter(isAlive)
    }
    if (pending.length) {
      throw new Error(`Dev lane processes survived SIGKILL after ${graceMs} ms: ${pending.join(', ')}`)
    }
  }
  return { timedOut, signalErrors, error: timeoutCallbackError }
}

/**
 * 一次关机算不算失败。
 *
 * `result.signal` 那一格问的是「它是被信号打死的吗」——**别人**打的才是失败;
 * 我们自己按流程送出去的那个信号把它送走,恰恰是关机成功的样子(工单 4 A6)。
 * 超时那一路另有 `timedOut` 记账,不靠这一格。
 */
export function shutdownFailed(result) {
  const killedByUs = Boolean(result.signal) && (result.sentSignals ?? []).includes(result.signal)
  return result.timedOut || result.signalErrors.length > 0 || Boolean(result.error)
    || (Boolean(result.signal) && !killedByUs)
    || (result.code !== undefined && result.code !== null && result.code !== 0)
}
