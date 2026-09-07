import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createChildShutdown, shutdownFailed } from '../../lib/dev-process-shutdown.mjs'

const [mode, duration = '2000'] = process.argv.slice(2)
const delayMs = Number(duration)
const send = message => process.send?.(message)

if (mode === 'launcher') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'delayed', duration], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  let childSignals = 0
  let requests = 0
  let shared = true
  let first
  let startedAt
  let reported = false
  const lifecycle = createChildShutdown({ child })
  child.on('message', message => {
    if (message.type === 'ready') send({ type: 'ready' })
    if (message.type === 'signal') {
      childSignals += 1
      send({ type: 'child-signal' })
    }
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      requests += 1
      startedAt ??= Date.now()
      const pending = lifecycle.stop(signal)
      if (first) shared &&= first === pending
      else first = pending
      void pending.then(result => {
        if (reported) return
        reported = true
        process.send({ type: 'report', requests, shared, childSignals, elapsed: Date.now() - startedAt, timedOut: result.timedOut },
          () => process.exit(shutdownFailed(result) ? 1 : 0))
      })
    })
  }
} else {
  let closing = false
  setInterval(() => {}, 60_000)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      send({ type: 'signal', signal })
      if (closing || mode === 'hung') return
      closing = true
      if (mode === 'close-gap') {
        // The direct child exits first; its descendant retains both output pipes.
        spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write('leaf-drained\\n'), ${delayMs})`], {
          stdio: ['ignore', 'inherit', 'inherit'],
        })
        process.exit(0)
      }
      setTimeout(() => process.exit(0), delayMs)
    })
  }
  send({ type: 'ready' })
}
