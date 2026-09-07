import fs from 'node:fs'
import path from 'node:path'
import { BackendResources } from '../../../../../packages/backend/lifecycle.js'
import { StoreLock } from '@onething/runtime/storage/store-lock'
import { createDesktopShutdownRequest } from '../../shutdown.js'

async function main(): Promise<void> {
  const directory = process.argv[2]!
  const failCleanup = process.argv[3] === 'fail'
  const lease = new StoreLock({ storePath: directory })
  await lease.acquire('desktop')
  const resources = new BackendResources()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const signals: string[] = []
  let cleanupCalls = 0
  let firstRequest: Promise<void> | undefined
  let sameRequest = true
  let failure: string | undefined
  resources.own(() => lease.release(), 'lease', 'release')
  resources.own(async () => {
    cleanupCalls += 1
    process.send?.({ event: 'cleanup-started' })
    await barrier
    if (failCleanup) throw new Error('fixture save failed')
    fs.writeFileSync(path.join(directory, 'saved.txt'), 'saved before lease release')
  }, 'pending-save', 'flush')
  const request = createDesktopShutdownRequest({
    shutdown: reason => resources.dispose(reason),
    onFailure: (_reason, error) => {
      failure = String(error)
      process.stderr.write(`shutdown failed; store lease released anyway: ${failure}\n`)
    },
    exit: code => {
      fs.writeFileSync(path.join(directory, 'exit.json'), JSON.stringify({
        code, failure, cleanupCalls, sameRequest, signals, held: lease.held,
      }))
      process.exit(code)
    },
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      signals.push(signal)
      const current = request(signal)
      if (firstRequest && current !== firstRequest) sameRequest = false
      firstRequest ??= current
      process.send?.({ event: 'signal', signal })
    })
  }
  process.on('message', message => {
    if (message === 'release') release()
    if (message === 'status') process.send?.({ event: 'status', held: lease.held, cleanupCalls, signals, sameRequest })
  })
  process.send?.({ event: 'ready' })
}

void main().catch(error => { process.stderr.write(String(error)); process.exit(2) })
