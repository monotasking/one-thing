import fs from 'node:fs'
import path from 'node:path'
import { createSessionDeletionRecovery } from '../../deletion-recovery.js'

const [sessionsDir, stage] = process.argv.slice(2)
const recovery = createSessionDeletionRecovery({ sessionsDir, assertOwned() {} })
const intent = recovery.prepare(['parent', 'child'])
const rename = fs.renameSync
fs.renameSync = ((from, to) => {
  rename(from, to)
  const destination = String(to)
  if ((stage === 'isolate' && destination.endsWith(path.join('resources', 'parent.directory')))
    || (stage === 'index' && destination === path.join(sessionsDir, 'index.json'))) {
    // Abrupt exit skips all JS finally/dispose logic on Windows as well as POSIX.
    process.exit(73)
  }
}) as typeof fs.renameSync
await recovery.commit(intent)
throw new Error('The selected crash point was not reached')
