import fs from 'node:fs'
import path from 'node:path'
import { restoreStoreBackup } from '../../store-backup.js'
import { canonicalizeStorePath } from '../../store-lock.js'
import { STORE_RESTORE_PENDING } from '../../store-backup.js'

const [backupPath, storePath] = process.argv.slice(2) as [string, string]
const canonicalTarget = canonicalizeStorePath(storePath)
const phase = process.argv[4] ?? 'copied-file'
const open = fs.openSync
const sync = fs.fsyncSync
const rename = fs.renameSync
let copiedFile: number | undefined
let markerFile: number | undefined
function pause() {
  fs.writeSync(1, 'COPIED\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
  const fd = open(...args)
  if (String(args[0]) === path.join(canonicalTarget, 'media/images/image.bin') && args[1] === 'wx') copiedFile = fd
  if (String(args[0]) === path.join(canonicalTarget, STORE_RESTORE_PENDING) && args[1] === 'r+') markerFile = fd
  return fd
}) as typeof fs.openSync
fs.renameSync = (from, to) => {
  if (phase === 'before-complete' && String(to) === path.join(canonicalTarget, STORE_RESTORE_PENDING)
    && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'complete') pause()
  rename(from, to)
}
fs.fsyncSync = fd => {
  sync(fd)
  if ((phase === 'copied-file' && fd === copiedFile)
    || (phase === 'after-complete' && fd === markerFile
      && JSON.parse(fs.readFileSync(path.join(canonicalTarget, STORE_RESTORE_PENDING), 'utf8')).state === 'complete')) {
    // Pause only after a real copied file is durable. The parent kills this
    // separate process with its lease and restore marker still in place.
    pause()
  }
}
void restoreStoreBackup({ backupPath, storePath }).catch(error => {
  fs.writeSync(2, `${error instanceof Error ? error.message : 'Restore failed'}\n`)
  process.exitCode = 1
})
