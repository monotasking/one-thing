import fs from 'node:fs'
import { LockConflictError, StoreLock } from '../../store-lock.js'

const lock = new StoreLock({ storePath: process.argv[2], version: 'child-test' })
const pauseAfterElection = process.argv[3] === 'pause-after-election'
if (pauseAfterElection) {
  const original = fs.mkdirSync
  fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
    const result = Reflect.apply(original, fs, args)
    if (args[0] === lock.lockPath) {
      process.send?.({ type: 'initializing' })
      // Parent controls the exact election/metadata interleaving through stdin.
      fs.readSync(0, Buffer.alloc(1), 0, 1, null)
    }
    return result
  }) as typeof fs.mkdirSync
}

process.on('message', async (message) => {
  if (message === 'acquire') {
    try {
      await lock.acquire('server')
      process.send?.({ type: 'acquired', pid: process.pid })
    } catch (error) {
      process.send?.({ type: error instanceof LockConflictError ? 'conflict' : 'error', message: String(error) })
    }
  } else if (message === 'release') {
    lock.release()
    process.send?.({ type: 'released' })
  }
})
process.send?.({ type: 'ready' })
