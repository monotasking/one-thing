/**
 * `gate:backend-process` 的**监督那一半**(第④步批 2b):不开窗地驱动桌面真正用的那只 `BackendProcess`
 * (`apps/desktop-react/electron/backend-process.ts`)拉起真 `backend.cjs`。
 *
 * 门(`scripts/gate-backend-process.mjs`)把这只文件用桌面同一份 esbuild 配方打成 cjs,再用 Electron 二进制 +
 * `ELECTRON_RUN_AS_NODE=1`(或系统 Node)起它 —— 于是 `process.execPath` 就是桌面拉起后端时用的那只二进制,
 * 与生产逐字同一条路,只是没有窗口。两种跑法(`GATE_SUPERVISOR_MODE`):
 *
 *  · `supervise`:拉起 → 活了 → `kill -9` 后端看 D11 重拉(端口与 token 不变、新 pid、发现文件跟着换)→ 再崩三次
 *    看第四次封顶(`stopped`、发现文件删掉)→「重启」清额度再拉 → `leave()`(「退出后继续运行」)后自己退出,
 *    把留下的那台后端 pid 交给门;
 *  · `adopt`:上一程留下的那台还活着 → `start()` 借它(不拉第二台、pid 不变、owner `backend` 归这里停)→ `stop()`
 *    (SIGTERM 一次,宽限内退,发现文件删掉)。
 *
 * 结果是一行 `__GATE_SUPERVISOR_RESULT__` + JSON:`{ checks: [{ label, ok, detail }], leftPid? }`。门逐项判。
 * store 由门递(临时目录),这里一个字节都不碰 `~/.onething`。
 */
import { BackendProcess, type BackendProcessSnapshot } from '../../apps/desktop-react/electron/backend-process.js'
import { pidAlive, readDiscovery, resolveStoreRoot } from '../../apps/desktop-react/electron/discovery.js'

const MARKER = '__GATE_SUPERVISOR_RESULT__'
const checks: Array<{ label: string; ok: boolean; detail: string }> = []
const check = (ok: boolean, label: string, detail = ''): void => { checks.push({ label, ok, detail }) }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

async function capabilitiesAnswer(baseUrl: string, token: string | undefined): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/capabilities`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
    return response.ok
  } catch {
    return false
  }
}

const storeRoot = resolveStoreRoot()
const entry = process.env.GATE_BACKEND_ENTRY ?? ''
const phases: BackendProcessSnapshot['phase'][] = []
const backend = new BackendProcess({
  execPath: process.execPath,
  entry,
  storeRoot,
  env: process.env,
  log: {
    info: () => {},
    warn: () => {},
    error: (msg, fields) => { process.stderr.write(`[supervisor] ${msg} ${JSON.stringify(fields ?? {})}\n`) },
  },
  onChange: snapshot => { phases.push(snapshot.phase) },
})

/** 杀掉当前那台(只杀这一程拉起的、pid 对得上发现文件的那一只),等监督把它重拉回来或者放弃。 */
async function crash(): Promise<number | undefined> {
  const pid = backend.state.pid
  if (pid === undefined) return undefined
  process.kill(pid, 'SIGKILL')
  await until(() => !pidAlive(pid), 5_000)
  return pid
}

async function supervise(): Promise<number | undefined> {
  const started = await backend.start()
  check(started.ok && !started.adopted, '拉起:活了,不是借来的', JSON.stringify(started).slice(0, 400))
  if (!started.ok) return undefined
  const first = readDiscovery(storeRoot)
  check(first?.owner === 'backend' && first.pid === backend.state.pid && first.pid !== process.pid, '发现文件 owner === backend,pid 是子进程', JSON.stringify(first))
  check(await capabilitiesAnswer(started.connection.baseUrl, started.connection.token), '拿这一程的 token 打得通 /api/capabilities')

  // ── D11:崩一次 → 自动重拉,端口与 token 不变 ──
  const crashed = await crash()
  const back = await until(() => backend.state.phase === 'running' && backend.state.pid !== crashed, 30_000)
  const second = readDiscovery(storeRoot)
  check(back && phases.includes('restarting'), '崩一次:自动重拉(经过 restarting)', `phases=${phases.join(',')}`)
  check(second?.port === first?.port && second?.token === first?.token && second?.pid === backend.state.pid && second?.pid !== crashed,
    '重拉之后端口与 token 不变、发现文件换成新 pid', `before=${JSON.stringify(first)} after=${JSON.stringify(second)}`)
  check(await capabilitiesAnswer(started.connection.baseUrl, started.connection.token), '渲染层手里那份地址与 token 照旧打得通')

  // ── 再崩三次:第二、三次照拉,第四次(60 秒内)封顶 ──
  for (let n = 2; n <= 3; n += 1) {
    const pid = await crash()
    const ok = await until(() => backend.state.phase === 'running' && backend.state.pid !== pid, 30_000)
    check(ok, `第 ${n} 次崩:照旧重拉`)
  }
  const last = await crash()
  const gaveUp = await until(() => backend.state.phase === 'stopped', 10_000)
  check(gaveUp, '60 秒内第 4 次崩:不再重拉,phase === stopped', `phase=${backend.state.phase}`)
  check(readDiscovery(storeRoot) === undefined && last !== undefined && !pidAlive(last), '封顶之后:发现文件删掉、没有后端进程留着')

  // ── 「重启」:清额度再拉 ──
  const restarted = await backend.restart()
  check(restarted.ok && backend.state.phase === 'running', '「重启」:清掉额度再拉一台', JSON.stringify(restarted).slice(0, 300))

  // ── 「退出后继续运行」:不发信号,子进程留着 ──
  const left = backend.state.pid
  backend.leave()
  return left
}

async function adopt(expectedPid: number): Promise<void> {
  const started = await backend.start()
  check(started.ok && started.adopted, '再起一程:发现文件活着就借它,不拉第二台', JSON.stringify(started).slice(0, 300))
  check(backend.state.pid === expectedPid && backend.ownsBackend, '借来的就是上一程留下的那台(owner backend,归这里停)', `pid=${backend.state.pid}`)
  const startedAt = Date.now()
  await backend.stop()
  const ms = Date.now() - startedAt
  check(!pidAlive(expectedPid) && ms <= 7_500, 'stop:SIGTERM 一次,宽限(5 + 2 秒)内退出', `ms=${ms}`)
  check(readDiscovery(storeRoot) === undefined, 'stop 之后发现文件删掉')
}

async function main(): Promise<void> {
  // `BackendProcess` 的计时器与子进程句柄全是 `unref()` 的(在 Electron 主进程里由 app 撑着事件循环);
  // 这只驱动没有 app,自己撑一只,否则 await 到一半事件循环空了进程就悄悄退了。
  const keepAlive = setInterval(() => {}, 1000)
  let leftPid: number | undefined
  try {
    if (!entry) throw new Error('GATE_BACKEND_ENTRY is not set')
    if (process.env.GATE_SUPERVISOR_MODE === 'adopt') await adopt(Number(process.env.GATE_EXPECTED_PID))
    else leftPid = await supervise()
  } catch (error) {
    check(false, '监督那一半跑完', error instanceof Error ? error.stack ?? error.message : String(error))
    // 半路红了:这一程拉起的那台收掉再走(它是 detached 的,不收就成了孤儿)。
    leftPid = undefined
    await backend.stop().catch(() => undefined)
  }
  clearInterval(keepAlive)
  process.stdout.write(`${MARKER}${JSON.stringify({ checks, ...(leftPid !== undefined ? { leftPid } : {}) })}\n`)
  // 「继续运行」那一程:子进程是 detached + unref 的,这里直接退,门再去看它还活着没有。
  process.exit(0)
}

void main()
