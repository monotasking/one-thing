import { readFileSync } from 'node:fs'
import {
  inspectStoreLock,
  quarantineStoreLockForRecovery,
  type StoreLockIdentity,
} from '@onething/runtime/storage/store-lock'
import { stdout } from './stdout.js'

type Flags = Readonly<Record<string, string | boolean>>

const INSPECT_USAGE = 'onething store lock [inspect] [--store <path>]'
const RECOVER_USAGE = 'onething store lock recover --store <stopped-store> --identity-file <reviewed-diagnostic.json> --all-hosts-stopped --automatic-restarts-disabled'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentity(value: unknown): value is StoreLockIdentity {
  if (!isRecord(value)) return false
  return ['device', 'inode', 'createdAt', 'modifiedAt'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]))
    && (value.kind === 'directory' || value.kind === 'file' || value.kind === 'other')
    && (value.metadataHash === null
      || (typeof value.metadataHash === 'string' && /^[a-f0-9]{64}$/.test(value.metadataHash)))
}

function assertFlags(flags: Flags, allowed: readonly string[]): void {
  const unsupported = Object.keys(flags).filter(name => !allowed.includes(name))
  if (unsupported.length) {
    throw new Error(`Unsupported store lock option: ${unsupported.map(name => `--${name}`).join(', ')}. Lock recovery has no force or online mode.`)
  }
  if (flags.store !== undefined && (typeof flags.store !== 'string' || flags.store.length === 0)) {
    throw new Error('--store requires a directory path.')
  }
}

/** Offline tooling only: never starts a daemon, acquires a lease, or assembles a Backend. */
export function storeLockCommand(
  action: string | undefined,
  args: string[],
  storePath: string | undefined,
  flags: Flags,
): void {
  if (args.length || (action !== undefined && action !== 'inspect' && action !== 'recover')) {
    throw new Error(`Usage: ${INSPECT_USAGE} | ${RECOVER_USAGE}`)
  }
  if (action !== 'recover') {
    assertFlags(flags, ['store', 'json'])
    stdout(JSON.stringify(inspectStoreLock({ storePath }), null, 2))
    return
  }

  assertFlags(flags, ['store', 'json', 'identity-file', 'all-hosts-stopped', 'automatic-restarts-disabled'])
  if (!storePath) throw new Error(`Recovery requires an explicit --store path. Usage: ${RECOVER_USAGE}`)
  if (flags['all-hosts-stopped'] !== true || flags['automatic-restarts-disabled'] !== true) {
    throw new Error(`Offline recovery requires --all-hosts-stopped and --automatic-restarts-disabled. Stop every host and disable automatic restarts before making these assertions. Usage: ${RECOVER_USAGE}`)
  }
  const identityFile = flags['identity-file']
  if (typeof identityFile !== 'string' || !identityFile) {
    throw new Error(`Recovery requires --identity-file containing the exact, reviewed JSON output of "${INSPECT_USAGE}". A missing PID alone is insufficient.`)
  }

  let reviewed: unknown
  try { reviewed = JSON.parse(readFileSync(identityFile, 'utf8')) }
  catch (cause) {
    throw new Error(`Cannot read reviewed lock diagnostic at ${identityFile}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
  if (!isRecord(reviewed) || typeof reviewed.storePath !== 'string'
    || typeof reviewed.lockPath !== 'string' || !isIdentity(reviewed.identity)) {
    throw new Error('The identity file must contain the complete inspected storePath, lockPath and non-null lock identity. Run "store lock inspect" again and review its output; no lock was changed.')
  }

  // This read selects the requested physical store, never a replacement expected
  // identity. Only the operator's earlier reviewed identity authorizes quarantine.
  const target = inspectStoreLock({ storePath })
  if (reviewed.storePath !== target.storePath || reviewed.lockPath !== target.lockPath) {
    throw new Error('The reviewed diagnostic belongs to a different store or lock path; no lock was changed.')
  }
  const quarantinePath = quarantineStoreLockForRecovery({
    storePath: target.storePath,
    expectedIdentity: reviewed.identity,
    allHostsStopped: true,
    automaticRestartsDisabled: true,
  })
  stdout(JSON.stringify({ quarantined: true, storePath: target.storePath, quarantinePath }, null, 2))
}
