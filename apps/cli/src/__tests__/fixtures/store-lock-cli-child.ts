import { StoreLock } from '@onething/runtime/storage/store-lock'

// Only the test parent owns this process. Exiting over IPC leaves the real lease
// intact, without platform-specific signals or touching any other process.
const lock = new StoreLock({ storePath: process.argv[2], version: 'store-lock-cli-fixture' })
process.on('message', (message: unknown) => {
  if (message === 'crash') process.exit(0)
})
process.on('disconnect', () => process.exit(0))

void lock.acquire('server').then(() => {
  process.send?.({ type: 'locked', pid: process.pid })
}).catch((error: unknown) => {
  process.send?.({ type: 'error', message: String(error) }, undefined, undefined, () => { process.exit(1) })
})
