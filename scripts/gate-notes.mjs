#!/usr/bin/env node
/**
 * `gate:notes` —— 笔记领域的真机门(P1,`docs/design/notes-obsidian-cli-2026-09.md` §5)。
 *
 * ## 这条门的纪律(它跑在**用户自己的 Obsidian 上**)
 *
 *  0. **P5 起多一步 ⑧**:活检索 `search:context format=json` 对**一个 open 的库**
 *     真跑一发(只读,查一个结构上不可能命中的词),外加 ⑧b「已经 abort 的信号
 *     → 一次 spawn 都不发生」。
 *  1. **只读**。唯一会写东西的一步是第 ⑤ 步的 `getDailyNote()`,而它**只对
 *     「今日日记文件已经存在」的库调** —— 那时它是幂等的(返回已有的那个文件)。
 *     没有这样的库就打印 skipped,绝不在用户的库里造文件。
 *  2. **socket 连不上就一条命令都不发**,打印 `skipped: obsidian not running`
 *     并 exit 0。发一条 = 把 Obsidian 拉起来。
 *  3. **只对 `obsidian.json` 里 `open: true` 的库发命令**。第 ⑥ 步把整场的
 *     spawn 账单打出来,并断言没有一条打给 `open:false` 的库。
 *  4. 每条命令 10s 预算,**读完 stdout 再返回**(提前关会让 CLI 挂死到 20s)。
 *  5. 快照只写**临时 store**,不碰 `~/.onething`。
 *  6. 第 ⑦ 步要证明「对一个 closed 库做后台读 = 零 spawn」,而它用的是一台
 *     **会抛的包装 runner**:vaultId 落在 closed 集里就 throw,**永远不真发**
 *     那条命令。哪怕是为了证明它不会发,也不许在用户机器上真发一次 —— 发了
 *     就是把那个库的窗口弹出来。
 *
 * 用法:`bun run gate:notes [--json]`。
 *
 * **为什么是 `bun` 而不是 `node`**(与 `boundary` 同一条):第 ⑦ 步要 import 领域
 * 自己的 `ObsidianVault`,而那是 TS 源码、内部用 `.js` 说明符指着 `.ts` 文件 ——
 * 裸 node 解析不了。裸 node 跑仍然可用,只是第 ⑦ 步会打印一条带理由的 skipped,
 * 不假装通过。
 */

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BUDGET_MS = 10_000
/** 零命中时 `search:context` 的原话(与领域里那份常量同一句)。 */
const NO_MATCHES = 'No matches found.'
const JSON_OUT = process.argv.includes('--json')
const EXECUTABLE = process.env.ONETHING_OBSIDIAN_CLI?.trim()
  || (process.platform === 'win32' ? 'obsidian.exe' : 'obsidian')

/** 整场的 spawn 账单 —— 第 ⑥ 步的判据。 */
const spawnLog = []
const steps = []

function say(...parts) {
  if (!JSON_OUT) console.log(...parts)
}

function record(name, status, detail) {
  steps.push({ name, status, detail })
  say(`${status === 'ok' ? '✅' : status === 'skipped' ? '⏭️ ' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── ① 名册 ────────────────────────────────────────────

function obsidianConfigCandidates() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [path.join(appData, 'obsidian', 'obsidian.json')]
  }
  return [
    path.join(home, '.config', 'obsidian', 'obsidian.json'),
    path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
  ]
}

function readRegistry() {
  for (const candidate of obsidianConfigCandidates()) {
    if (!fs.existsSync(candidate)) continue
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
    const vaults = Object.entries(parsed.vaults ?? {})
      .filter(([, entry]) => typeof entry?.path === 'string')
      .map(([id, entry]) => ({ id, path: entry.path, open: entry.open === true }))
    return { vaults, cliRegistered: parsed.cli === true, sourcePath: candidate }
  }
  return { vaults: [], cliRegistered: false, sourcePath: null }
}

// ── ② 探活 ────────────────────────────────────────────

function socketPath() {
  if (process.platform === 'win32') return null
  return path.join(os.homedir(), '.obsidian-cli.sock')
}

function probeSocket(file) {
  return new Promise(resolve => {
    if (file === null) { resolve(false); return }
    let done = false
    const settle = value => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* already gone */ }
      resolve(value)
    }
    const socket = net.connect(file)
    socket.setTimeout(1000)
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.once('timeout', () => settle(false))
  })
}

// ── CLI(读完 stdout 再返回 + 10s 预算 + 进程组) ─────────

function runCli(vaultId, command, params = []) {
  const args = [`vault=${vaultId}`, command, ...params]
  spawnLog.push({ vaultId, args })
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== 'win32'
    const child = spawn(EXECUTABLE, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: processGroup })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer
    const signal = value => {
      if (processGroup && child.pid) {
        try { process.kill(-child.pid, value) } catch { child.kill(value) }
      } else child.kill(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      signal('SIGTERM')
      killTimer = setTimeout(() => signal('SIGKILL'), 1000)
    }, BUDGET_MS)
    // 只累加,**不提前关** stdout。
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.end()
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (timedOut) { reject(new Error(`${command} timed out after ${BUDGET_MS}ms`)); return }
      resolve({ stdout: stdout.replace(/\s+$/, ''), stderr })
    })
  })
}

/** 退出码恒 0 —— 错在 stdout 首行。 */
function judge(stdout) {
  const firstLine = stdout.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
  if (firstLine.startsWith('Error:')) return { ok: false, error: firstLine.slice(6).trim() }
  if (stdout.trim() === 'Vault not found.') return { ok: false, error: 'Vault not found.' }
  return { ok: true, value: stdout }
}

function stripArrow(stdout) {
  const text = stdout.trim()
  return text.startsWith('=>') ? text.slice(2).trim() : text
}

// ── 三段只读 eval ──────────────────────────────────────

const SCRIPTS = {
  vaultConfig: 'JSON.stringify({attachmentFolderPath:app.vault.getConfig("attachmentFolderPath"),'
    + 'useMarkdownLinks:app.vault.getConfig("useMarkdownLinks"),'
    + 'newLinkFormat:app.vault.getConfig("newLinkFormat")})',
  dailyOptions: 'JSON.stringify(app.internalPlugins.getPluginById("daily-notes")?.instance?.options ?? null)',
  resolveLink: 'app.metadataCache.getFirstLinkpathDest("__onething_gate_no_such_note__", "")?.path ?? null',
  getDailyNote: '(async()=>(await app.internalPlugins.getPluginById("daily-notes").instance.getDailyNote()).path)()',
}

async function main() {
  let failures = 0
  const fail = (name, detail) => { failures += 1; record(name, 'failed', detail) }

  // ① 名册
  const registry = readRegistry()
  if (registry.sourcePath === null) {
    record('① obsidian.json', 'skipped', 'no registry on this machine — Obsidian is not installed')
    return finish(0)
  }
  const openVaults = registry.vaults.filter(v => v.open)
  record('① obsidian.json', 'ok',
    `${registry.vaults.length} vaults (${openVaults.length} open), cli=${registry.cliRegistered}`)
  for (const vault of registry.vaults) {
    say(`     ${vault.open ? 'open  ' : 'closed'} ${vault.id}  ${vault.path}`)
  }

  // ② 探活 —— 连不上就一条命令都不发
  const alive = await probeSocket(socketPath())
  if (!alive) {
    record('② liveness probe', 'skipped', 'skipped: obsidian not running')
    return finish(0)
  }
  record('② liveness probe', 'ok', `${socketPath()} accepts connections`)

  if (openVaults.length === 0) {
    record('③ per-vault reads', 'skipped', 'no open vault — sending a command would launch one')
    return finish(failures)
  }

  // ③ 每个 open 的库:vault info=path 对得上名册 + 三段 eval 能解析 + daily:path
  const snapshots = new Map()
  for (const vault of openVaults) {
    const label = `③ ${vault.id} (${path.basename(vault.path)})`

    const info = judge((await runCli(vault.id, 'vault', ['info=path'])).stdout)
    if (!info.ok) { fail(`${label} vault info=path`, info.error); continue }
    if (path.resolve(info.value) !== path.resolve(vault.path)) {
      fail(`${label} vault info=path`, `CLI says ${info.value}, registry says ${vault.path}`)
      continue
    }

    let config
    let dailyOptions
    try {
      const raw = judge((await runCli(vault.id, 'eval', [`code=${SCRIPTS.vaultConfig}`])).stdout)
      if (!raw.ok) { fail(`${label} eval vaultConfig`, raw.error); continue }
      config = JSON.parse(stripArrow(raw.value))
      const rawDaily = judge((await runCli(vault.id, 'eval', [`code=${SCRIPTS.dailyOptions}`])).stdout)
      if (!rawDaily.ok) { fail(`${label} eval dailyOptions`, rawDaily.error); continue }
      dailyOptions = JSON.parse(stripArrow(rawDaily.value))
      const rawResolve = judge((await runCli(vault.id, 'eval', [`code=${SCRIPTS.resolveLink}`])).stdout)
      if (!rawResolve.ok) { fail(`${label} eval resolveLink`, rawResolve.error); continue }
      // 一个一定不存在的名字 —— 答案必须是 `null`,证明这段脚本真的跑了。
      if (stripArrow(rawResolve.value) !== 'null') {
        fail(`${label} eval resolveLink`, `expected null, got ${rawResolve.value}`)
        continue
      }
    } catch (error) {
      fail(`${label} eval`, error.message)
      continue
    }

    // daily:path —— 相对路径,或者被结构化成一条 Folder not found 错误
    const daily = judge((await runCli(vault.id, 'daily:path')).stdout)
    let dailyRelative = null
    if (daily.ok) {
      if (path.isAbsolute(daily.value)) { fail(`${label} daily:path`, `expected a vault-relative path, got ${daily.value}`); continue }
      // **空答案不是相对路径**。真机上见过一次(6 次里 1 次):Obsidian 忙的时候
      // `daily:path` 回一行空的。它不是契约违反(没说错话),但也不能当成一个
      // 路径用下去 —— 记一条可见的 skipped,别让第 ⑤ 步拿它去比对。
      if (daily.value.trim() === '') {
        record(`${label} daily:path`, 'skipped', 'the CLI answered an empty line this run')
      } else dailyRelative = daily.value
    } else if (!/^Folder ".*" not found\.$/.test(daily.error)) {
      fail(`${label} daily:path`, `unexpected error shape: ${daily.error}`)
      continue
    }

    snapshots.set(vault.id, {
      dailyFolder: (dailyOptions?.folder ?? '').replace(/^\/+|\/+$/g, ''),
      dailyFormat: dailyOptions?.format || 'YYYY-MM-DD',
      dailyTemplate: dailyOptions?.template || undefined,
      attachmentFolderPath: config.attachmentFolderPath ?? '',
      useMarkdownLinks: config.useMarkdownLinks === true,
      newLinkFormat: config.newLinkFormat ?? 'shortest',
      capturedAt: Date.now(),
      __dailyRelative: dailyRelative,
    })
    record(label, 'ok',
      `daily=${dailyRelative ?? '(no daily folder)'} attach="${config.attachmentFolderPath}" md=${config.useMarkdownLinks}`)
  }

  // ④ 快照写进**临时** store 并读回
  const tmpStore = await fsp.mkdtemp(path.join(os.tmpdir(), 'onething-gate-notes-'))
  try {
    const dir = path.join(tmpStore, 'notes', 'obsidian')
    await fsp.mkdir(dir, { recursive: true })
    let roundTrips = 0
    for (const [id, snapshot] of snapshots) {
      const file = path.join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
      await fsp.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf-8')
      const back = JSON.parse(await fsp.readFile(file, 'utf-8'))
      if (back.dailyFormat !== snapshot.dailyFormat || back.attachmentFolderPath !== snapshot.attachmentFolderPath) {
        fail('④ snapshot round-trip', `mismatch for ${id}`)
      } else roundTrips += 1
    }
    record('④ snapshot round-trip', 'ok', `${roundTrips} snapshots in ${tmpStore} (never ~/.onething)`)
  } finally {
    await fsp.rm(tmpStore, { recursive: true, force: true })
  }

  // ⑤ 「新建今日」—— 只对今日日记**已存在**的库调(幂等,不造文件)
  const idempotent = [...snapshots.entries()].find(([id, snapshot]) => {
    if (!snapshot.__dailyRelative) return false
    const vault = openVaults.find(v => v.id === id)
    return vault && fs.existsSync(path.join(vault.path, snapshot.__dailyRelative))
  })
  if (!idempotent) {
    record('⑤ getDailyNote()', 'skipped',
      'no open vault whose today-note already exists — calling it would create a file')
  } else {
    const [id, snapshot] = idempotent
    const result = judge((await runCli(id, 'eval', [`code=${SCRIPTS.getDailyNote}`])).stdout)
    if (!result.ok) fail('⑤ getDailyNote()', result.error)
    else {
      const returned = stripArrow(result.value)
      if (returned !== snapshot.__dailyRelative) {
        fail('⑤ getDailyNote()', `returned ${returned}, daily:path said ${snapshot.__dailyRelative}`)
      } else {
        record('⑤ getDailyNote()', 'ok', `${id} → ${returned} (idempotent: the file already existed)`)
      }
    }
  }

  // ⑧ 活检索(P5):`search:context format=json` 对一个 **open** 的库真跑一发
  failures += await assertLiveSearchReads(openVaults)

  // ⑦ 走真的 ObsidianVault 对 closed 库做后台读:零 spawn
  //
  // **返回值要计进 failures**:第一版把它丢掉了,于是这一步打了 ❌ 而收场行
  // 仍然是 `ok` —— 一条自己不算数的门比没有门更坏。
  failures += await assertClosedVaultsStayQuiet(registry)

  // ⑥ spawn 账单:没有一条打给 open:false 的库
  const closedIds = new Set(registry.vaults.filter(v => !v.open).map(v => v.id))
  const offenders = spawnLog.filter(entry => closedIds.has(entry.vaultId))
  say('')
  say(`   spawn ledger: ${spawnLog.length} commands`)
  for (const entry of spawnLog) say(`     ${EXECUTABLE} ${entry.args.join(' ')}`)
  if (offenders.length > 0) {
    fail('⑥ no command reached a closed vault', `${offenders.length} offending command(s)`)
  } else {
    record('⑥ no command reached a closed vault', 'ok',
      `${closedIds.size} closed vault(s) were never addressed`)
  }

  return finish(failures)
}

/**
 * ⑧ **活检索真跑一发**(P5,正本 §4.3)。
 *
 * 纪律没变:`search:context` 是**只读**的(它不建文件、不改配置),而且只对
 * `open: true` 的库发 —— 与这条门的第 3 条一样。查的词是一个结构上不可能命中的
 * 串,所以它证的是「这条路通着、答案解析得动」,不是「这个库里有什么」:一个
 * 答不出东西的库与一个真有命中的库在这里应该是同一种绿。
 *
 * 顺带证第二件事:**换词即 kill**。同一条命令带一个已经 abort 的信号再发一次,
 * 领域那一侧必须**一次 spawn 都不发生** —— 账单上的条数不许涨。
 */
async function assertLiveSearchReads(openVaults) {
  // 这只函数在 `main()` 外面,拿不到那只闭包 `fail` —— 与 ⑦ 同一种写法:
  // 自己记一条 failed 再 `return 1`,由调用方把它加进 failures。
  const failLocal = (name, detail) => record(name, 'failed', detail)
  const target = openVaults[0]
  if (target === undefined) {
    record('⑧ liveSearch', 'skipped', 'no open vault to ask')
    return 0
  }
  // 结构上不可能命中的词:它证的是通路,不是这个库里有什么。
  const needle = '__onething_gate_no_such_note__'
  const { stdout } = await runCli(target.id, 'search:context', [`query=${needle}`, 'format=json'])
  const trimmed = stdout.trim()
  let parsed
  // **零命中时它答一句人话**(`No matches found.`,2026-09-18 这条门第一次跑撞出来
  // 的真读数)。领域那一侧认的就是这一句,门也认同一句 —— 两边不许分家。
  if (trimmed === NO_MATCHES) parsed = []
  else {
    try {
      parsed = trimmed === '' ? [] : JSON.parse(trimmed)
    } catch {
      failLocal('⑧ liveSearch', `search:context answered something that is neither JSON nor "${NO_MATCHES}": ${trimmed.slice(0, 120)}`)
      return 1
    }
  }
  if (!Array.isArray(parsed)) {
    failLocal('⑧ liveSearch', `expected an array, got ${typeof parsed}`)
    return 1
  }
  record('⑧ liveSearch', 'ok',
    `${target.id} — search:context format=json → ${parsed.length} hit(s) for a needle that cannot exist`)

  // ⑧b 换词即 kill:已经 abort 的信号 → 一次 spawn 都不发生。
  let domain
  try {
    domain = await import(pathToFileURL(
      path.join(import.meta.dirname, '..', 'packages', 'onething-runtime', 'src', 'notes', 'index.ts'),
    ).href)
  } catch (error) {
    record('⑧b aborted liveSearch spawns nothing', 'skipped',
      `cannot import the notes domain from this runtime (${error?.message ?? error})`)
    return 0
  }
  const before = spawnLog.length
  const controller = new AbortController()
  controller.abort()
  const runner = domain.createNodeProcessRunner()
  try {
    await runner.run({
      command: EXECUTABLE,
      args: [`vault=${target.id}`, 'search:context', `query=${needle}`, 'format=json'],
      timeoutMs: BUDGET_MS,
      signal: controller.signal,
    })
    failLocal('⑧b aborted liveSearch spawns nothing', 'the aborted call resolved instead of refusing')
    return 1
  } catch (error) {
    if (!(error instanceof domain.NoteProcessAborted)) {
      failLocal('⑧b aborted liveSearch spawns nothing', `wrong error: ${error?.message ?? error}`)
      return 1
    }
  }
  if (spawnLog.length !== before) {
    failLocal('⑧b aborted liveSearch spawns nothing', `${spawnLog.length - before} new spawn(s)`)
    return 1
  }
  record('⑧b aborted liveSearch spawns nothing', 'ok',
    'an already-aborted signal refused before the child was started')
  return 0
}

/**
 * ⑦ 用**领域自己的类**(不是门里重写一份判据)对每个 `open:false` 的库做两次
 * 后台读,断言一条命令都没发出去。
 *
 * 包装 runner:vaultId 属于 closed 集就 `throw`。这样「它其实发了」会变成一次
 * 可见的异常,而不是一条真的打到 Obsidian 的命令 —— 门在用户机器上跑,证明的
 * 代价不能是把那个库弹出来。
 */
async function assertClosedVaultsStayQuiet(registry) {
  const closed = registry.vaults.filter(v => !v.open)
  if (closed.length === 0) {
    record('⑦ closed vaults stay quiet', 'skipped', 'every vault in the registry is open')
    return 0
  }

  let domain
  try {
    domain = await import(pathToFileURL(
      path.join(import.meta.dirname, '..', 'packages', 'onething-runtime', 'src', 'notes', 'index.ts'),
    ).href)
  } catch (error) {
    // 门跑在裸 node 上,没有 TS 加载器时这一步无从执行 —— 说清楚,不假装通过。
    record('⑦ closed vaults stay quiet', 'skipped',
      `cannot import the notes domain from this runtime (${error?.message ?? error})`)
    return 0
  }

  const closedIds = new Set(closed.map(v => v.id))
  let attempted = 0
  const refusingRunner = {
    run: options => {
      const vaultArg = options.args?.[0] ?? ''
      if (closedIds.has(vaultArg.replace(/^vault=/, ''))) {
        attempted += 1
        throw new Error(`REFUSED: a background read addressed the closed vault ${vaultArg}`)
      }
      // 门里这条路不该被走到;真走到了也不发命令。
      attempted += 1
      throw new Error(`REFUSED: unexpected command ${options.args?.join(' ')}`)
    },
    spawn: () => { throw new Error('REFUSED: spawn') },
  }

  const before = spawnLog.length
  const tmpStore = await fsp.mkdtemp(path.join(os.tmpdir(), 'onething-gate-notes-closed-'))
  try {
    const snapshots = new domain.FileSnapshotStore(path.join(tmpStore, 'notes', 'obsidian'))
    const cli = new domain.ObsidianCli({
      runner: refusingRunner,
      // 探针说**活着** —— 那正是这一步要测的那一档:app 在跑,库没开。
      probe: { isAlive: async () => true },
      executable: EXECUTABLE,
    })
    for (const record_ of closed) {
      // 先塞一份假快照,让降级路走得下去(不然它会抛 no-snapshot,测不到点子上)。
      await snapshots.write(record_.id, {
        dailyFolder: 'daily',
        dailyFormat: 'YYYY-MM-DD',
        attachmentFolderPath: 'attach',
        useMarkdownLinks: false,
        newLinkFormat: 'shortest',
        capturedAt: Date.now(),
      })
      const vault = new domain.ObsidianVault({ record: record_, cli, snapshots })
      await vault.dailyNote()
      await vault.attachmentPathFor('x.png', path.join(record_.path, 'a.md'))
    }
  } catch (error) {
    record('⑦ closed vaults stay quiet', 'failed', error?.message ?? String(error))
    await fsp.rm(tmpStore, { recursive: true, force: true })
    return 1
  }
  await fsp.rm(tmpStore, { recursive: true, force: true })

  if (attempted !== 0 || spawnLog.length !== before) {
    record('⑦ closed vaults stay quiet', 'failed',
      `${attempted} refused attempt(s), ${spawnLog.length - before} new spawn(s)`)
    return 1
  }
  record('⑦ closed vaults stay quiet', 'ok',
    `${closed.length} closed vault(s) × (dailyNote + attachmentPathFor) → zero commands`)
  return 0
}

function finish(failures) {
  if (JSON_OUT) console.log(JSON.stringify({ steps, spawns: spawnLog, failures }, null, 2))
  else {
    say('')
    say(failures === 0 ? '[gate:notes] ok' : `[gate:notes] failed: ${failures}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('[gate:notes] crashed:', error?.stack ?? error)
  process.exit(1)
})
