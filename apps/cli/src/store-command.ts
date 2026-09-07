import { createStoreBackup, restoreStoreBackup, verifyStoreBackup } from '@onething/runtime/storage'
import { stdout } from './stdout.js'
import { storeLockCommand } from './store-lock-command.js'

/** Offline operations deliberately never start a daemon or assemble a Backend. */
export async function storeCommand(command: string | undefined, args: string[], storePath?: string,
  flags: Readonly<Record<string, string | boolean>> = {}): Promise<void> {
  if (command === 'lock') {
    const [action, ...rest] = args
    storeLockCommand(action, rest, storePath, flags)
  } else if (command === 'backup' && args.length === 1 && storePath) {
    const manifest = await createStoreBackup({ storePath, backupPath: args[0]! })
    stdout(JSON.stringify({ backupPath: args[0], entries: manifest.entries.length }))
  } else if (command === 'verify' && args.length === 1) {
    const manifest = verifyStoreBackup({ backupPath: args[0]! })
    stdout(JSON.stringify({ valid: true, entries: manifest.entries.length }))
  } else if (command === 'restore' && args.length === 2) {
    const manifest = await restoreStoreBackup({ backupPath: args[0]!, storePath: args[1]! })
    stdout(JSON.stringify({ storePath: args[1], staged: true, activationStorePath: manifest.activationStorePath,
      entries: manifest.entries.length }))
  } else {
    throw new Error('Usage: onething store lock [inspect|recover] | store backup <new-backup-dir> --store <stopped-store> | store verify <backup-dir> | store restore <backup-dir> <new-store-dir>')
  }
}
