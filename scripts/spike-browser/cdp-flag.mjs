/**
 * B0 spike ③ —— CDP 开关打架(方案 §9-4 的量项)
 *
 * 问题:产品要在 `ready` 前 `app.commandLine.appendSwitch('remote-debugging-port', <设置里的口>)`,
 * 而真机门自己是用 `--remote-debugging-port=<随机>` 起进程的(`scripts/gate-packaged.mjs:65`)。
 * 两边同名开关撞在一起,最终**哪个口在听**?`app.commandLine.hasSwitch()` 能不能当「argv 里已经带了,
 * 我就别 append」的判据?
 *
 * 跑法(从仓根):
 *   ./node_modules/.bin/electron scripts/spike-browser/cdp-flag.mjs --user-data-dir=<临时> \
 *      --remote-debugging-port=<A> -- --append-port=<B>
 *   不传 --append-port 就只验 argv 那一半;不传 --remote-debugging-port 就只验 append 那一半。
 *
 * 只读:不开窗、不碰 ~/.onething、不写盘。结论打在 stdout 的一行 JSON 里(前缀 SPIKE3_JSON=)。
 */
import { app } from 'electron'

const argv = process.argv.slice(1)
const readArg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const argvPort = readArg('remote-debugging-port')
const appendPort = readArg('append-port')

const report = {
  argvPort: argvPort ?? null,
  appendPort: appendPort ?? null,
  /** ready 之前、append 之前:argv 里带了开关时 hasSwitch 是不是 true(9-4 的判据靠它) */
  beforeAppend: {
    hasSwitch: app.commandLine.hasSwitch('remote-debugging-port'),
    value: app.commandLine.getSwitchValue('remote-debugging-port'),
  },
  afterAppend: null,
  listening: {},
  verdict: null,
}

if (appendPort) {
  app.commandLine.appendSwitch('remote-debugging-port', appendPort)
  report.afterAppend = {
    hasSwitch: app.commandLine.hasSwitch('remote-debugging-port'),
    value: app.commandLine.getSwitchValue('remote-debugging-port'),
  }
}

async function probe(port) {
  if (!port) return null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    })
    const body = await res.json()
    return { ok: true, status: res.status, browser: body.Browser, wsPrefix: String(body.webSocketDebuggerUrl || '').slice(0, 40) }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

app.whenReady().then(async () => {
  // Chromium 起 devtools http server 是异步的,给它一拍
  await new Promise((r) => setTimeout(r, 800))
  for (const [label, port] of [['argv', argvPort], ['append', appendPort]]) {
    if (port) report.listening[`${label}:${port}`] = await probe(port)
  }
  const winners = Object.entries(report.listening).filter(([, v]) => v?.ok).map(([k]) => k)
  report.verdict = winners.length === 0 ? 'NONE-LISTENING' : winners.join(' + ')
  console.log('SPIKE3_JSON=' + JSON.stringify(report))
  app.quit()
})
