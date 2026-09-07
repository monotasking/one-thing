import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'vitest'
import {
  createChildShutdown,
  observeChildClose,
  shutdownFailed,
  stopPidSnapshot,
} from '../lib/dev-process-shutdown.mjs'

const fixture = fileURLToPath(new URL('./fixtures/dev-process-shutdown-child.mjs', import.meta.url))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const cleanups = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map(clean => clean()))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed')
})

function processAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`No ${type} message from child`)), 7000)
    const onMessage = message => { if (message.type === type) finish(undefined, message) }
    const onClose = (code, signal) => finish(new Error(`Child closed before ${type}: ${code}/${signal}`))
    const finish = (error, message) => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('close', onClose)
      if (error) reject(error)
      else resolve(message)
    }
    child.on('message', onMessage)
    child.once('close', onClose)
  })
}

function childFixture(_context, mode, duration) {
  const child = spawn(process.execPath, [fixture, mode, String(duration)], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const close = observeChildClose(child)
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  cleanups.push(async () => {
    // Only the group created by this fixture; never inspect or affect host apps.
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
    await close.promise
  })
  return { child, close, get output() { return output } }
}

test.skipIf(process.platform === 'win32')('a real launcher shares repeated signal shutdown while the child drains for more than 1.2 s', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'launcher', 2000)
  await waitForMessage(child, 'ready')
  const signalled = waitForMessage(child, 'child-signal')
  const report = waitForMessage(child, 'report')
  child.kill('SIGTERM')
  await signalled
  await delay(1300)
  assert.equal(close.result, undefined, 'launcher must remain alive during cleanup')
  child.kill('SIGINT')
  await delay(30)
  child.kill('SIGTERM')
  const result = await report
  assert.ok(result.requests >= 2)
  assert.equal(result.shared, true)
  assert.equal(result.childSignals, 1, 'duplicate launcher signals must not be forwarded again')
  assert.equal(result.timedOut, false)
  assert.ok(result.elapsed >= 1900)
  assert.equal((await close.promise).code, 0)
})

test.skipIf(process.platform === 'win32')('shutdown waits for real close after exit while inherited output is still open', { timeout: 10_000 }, async t => {
  const fixtureChild = childFixture(t, 'close-gap', 1500)
  const { child, close } = fixtureChild
  const lifecycle = createChildShutdown({ child, close, graceMs: 5000 })
  await waitForMessage(child, 'ready')
  const exited = once(child, 'exit')
  let settled = false
  const stopping = lifecycle.stop()
  void stopping.then(() => { settled = true })
  await exited
  assert.equal(close.result, undefined)
  assert.equal(settled, false, 'exit must not resolve the shutdown barrier')
  const result = await stopping
  assert.equal(result.timedOut, false)
  assert.equal(result.code, 0)
  assert.match(fixtureChild.output, /leaf-drained/)
})

test.skipIf(process.platform === 'win32')('a timed out child is forced once, observed closed, and remains a failed shutdown', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'hung', 0)
  await waitForMessage(child, 'ready')
  const signals = []
  let timeoutReports = 0
  const lifecycle = createChildShutdown({
    child, close, graceMs: 150,
    sendSignal: signal => { signals.push(signal); child.kill(signal) },
    onTimeout: () => { timeoutReports += 1 },
  })
  const stopping = lifecycle.stop()
  assert.equal(lifecycle.stop('SIGINT'), stopping)
  const result = await stopping
  assert.equal(close.result.signal, 'SIGKILL')
  assert.equal(processAlive(child.pid), false)
  assert.equal(result.timedOut, true)
  assert.equal(shutdownFailed(result), true)
  assert.equal(timeoutReports, 1)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(lifecycle.stop(), stopping)
})

test.skipIf(process.platform === 'win32')('PID cleanup allows the full grace and only signals the original snapshot', { timeout: 10_000 }, async t => {
  const first = childFixture(t, 'delayed', 1400)
  const second = childFixture(t, 'hung', 0)
  await Promise.all([waitForMessage(first.child, 'ready'), waitForMessage(second.child, 'ready')])
  const pids = [first.child.pid, first.child.pid]
  const sent = []
  const startedAt = Date.now()
  const stopping = stopPidSnapshot({
    pids, graceMs: 3000, isAlive: processAlive,
    sendSignal: (pid, signal) => { sent.push({ pid, signal }); process.kill(pid, signal) },
  })
  pids.push(second.child.pid)
  const result = await stopping
  await first.close.promise
  assert.ok(Date.now() - startedAt >= 1300)
  assert.equal(shutdownFailed(result), false)
  assert.deepEqual(sent, [{ pid: first.child.pid, signal: 'SIGTERM' }])
  assert.equal(processAlive(second.child.pid), true)
})

test.skipIf(process.platform === 'win32')('PID timeout reports failure and waits until the recorded process is gone', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'hung', 0)
  await waitForMessage(child, 'ready')
  const reports = []
  const result = await stopPidSnapshot({
    pids: [child.pid], graceMs: 150, isAlive: processAlive,
    sendSignal: (pid, signal) => process.kill(pid, signal),
    onTimeout: pids => reports.push(pids),
  })
  await close.promise
  assert.equal(processAlive(child.pid), false)
  assert.deepEqual(reports, [[child.pid]])
  assert.equal(shutdownFailed(result), true)
})

test('only a completed zero-code shutdown without delivery errors is successful', () => {
  const clean = { timedOut: false, signalErrors: [], code: 0, signal: null }
  assert.equal(shutdownFailed(clean), false)
  assert.equal(shutdownFailed({ ...clean, code: 1 }), true)
  assert.equal(shutdownFailed({ ...clean, code: null, signal: 'SIGTERM' }), true)
  assert.equal(shutdownFailed({ ...clean, timedOut: true }), true)
  assert.equal(shutdownFailed({ ...clean, signalErrors: [new Error('delivery failed')] }), true)
  assert.equal(shutdownFailed({ ...clean, error: new Error('observer failed') }), true)
})

test('a child that died from the signal we sent is a clean shutdown, not a failure', () => {
  // 工单 4 A6:Ctrl-C 的正常形状就是「我们发 SIGTERM、它死于 SIGTERM」。
  const clean = { timedOut: false, signalErrors: [], code: null, signal: 'SIGTERM' }
  assert.equal(shutdownFailed({ ...clean, sentSignals: ['SIGTERM'] }), false)
  // 别人打的那一发仍然是失败。
  assert.equal(shutdownFailed({ ...clean, signal: 'SIGKILL', sentSignals: ['SIGTERM'] }), true)
  // 我们打的 SIGKILL 是超时之后的强杀 —— 那一路由 timedOut 记账,照旧失败。
  assert.equal(shutdownFailed({ ...clean, signal: 'SIGKILL', timedOut: true, sentSignals: ['SIGTERM', 'SIGKILL'] }), true)
})

test.skipIf(process.platform === 'win32')('Ctrl-C on a child that dies from SIGTERM exits clean', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'hung', 0)
  await waitForMessage(child, 'ready')
  const lifecycle = createChildShutdown({ child, close, graceMs: 5000, sendSignal: () => process.kill(child.pid, 'SIGKILL') })
  // 用 SIGKILL 作实弹(`hung` 这只不理 SIGTERM),但**请求的就是它** ——
  // 判据是「死因是不是我们点的那一发」,不是信号叫什么名字。
  const result = await lifecycle.stop('SIGKILL')
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(result.timedOut, false)
  assert.equal(shutdownFailed(result), false)
})

test('a process that survives SIGKILL fails the drain instead of hanging forever', { timeout: 10_000 }, async () => {
  // 工单 4 A6:强杀之后那段等待从前是无界 `while`。这里用一个永远「活着」的
  // 替身把那条路走通:今天它在同一份宽限期后如实抛,而不是永远不返回。
  const sent = []
  await assert.rejects(
    stopPidSnapshot({
      pids: [999999], graceMs: 150, isAlive: () => true,
      sendSignal: (pid, signal) => { sent.push(signal) },
    }),
    /survived SIGKILL after 150 ms/,
  )
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL'])
})

test.skipIf(process.platform === 'win32')('an externally killed child during stop cannot be reported as a successful drain', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'delayed', 2000)
  await waitForMessage(child, 'ready')
  const signalled = waitForMessage(child, 'signal')
  const lifecycle = createChildShutdown({ child, close })
  const stopping = lifecycle.stop()
  await signalled
  child.kill('SIGKILL')
  const result = await stopping
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(shutdownFailed(result), true)
  assert.equal(processAlive(child.pid), false)
})

test.skipIf(process.platform === 'win32')('natural observation of an unexpected signal remains failure when stop follows close', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'hung', 0)
  await waitForMessage(child, 'ready')
  child.kill('SIGKILL')
  await close.promise
  const signals = []
  const lifecycle = createChildShutdown({ child, close, sendSignal: signal => signals.push(signal) })
  const result = await lifecycle.stop()
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(shutdownFailed(result), true)
  assert.deepEqual(signals, [])
})

test.skipIf(process.platform === 'win32')('a signal error remains failure even when the child later closes cleanly', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'delayed', 10)
  await waitForMessage(child, 'ready')
  const failure = new Error('fixture signal delivery failed')
  const lifecycle = createChildShutdown({ child, close, sendSignal: () => { throw failure } })
  const stopping = lifecycle.stop()
  await delay(30)
  assert.equal(close.result, undefined)
  child.kill('SIGTERM')
  const result = await stopping
  assert.equal(result.code, 0)
  assert.deepEqual(result.signalErrors, [failure])
  assert.equal(shutdownFailed(result), true)
})

test.skipIf(process.platform === 'win32')('a throwing timeout reporter cannot skip forced stop or the real close barrier', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'hung', 0)
  await waitForMessage(child, 'ready')
  const failure = new Error('fixture timeout reporter failed')
  const lifecycle = createChildShutdown({ child, close, graceMs: 100, onTimeout: () => { throw failure } })
  const result = await lifecycle.stop()
  assert.equal(close.result.signal, 'SIGKILL')
  assert.equal(processAlive(child.pid), false)
  assert.equal(result.error.cause, failure)
  assert.equal(shutdownFailed(result), true)
})

test.skipIf(process.platform === 'win32')('a throwing PID timeout reporter still waits for the recorded process to stop', { timeout: 10_000 }, async t => {
  const { child, close } = childFixture(t, 'hung', 0)
  await waitForMessage(child, 'ready')
  const failure = new Error('fixture PID timeout reporter failed')
  const result = await stopPidSnapshot({
    pids: [child.pid], graceMs: 100, isAlive: processAlive,
    sendSignal: (pid, signal) => process.kill(pid, signal),
    onTimeout: () => { throw failure },
  })
  await close.promise
  assert.equal(processAlive(child.pid), false)
  assert.equal(result.error.cause, failure)
  assert.equal(shutdownFailed(result), true)
})
