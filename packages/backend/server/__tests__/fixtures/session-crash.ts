import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

async function main() {
const [mode, storePath, parentId, childId] = process.argv.slice(2)
process.env.ONETHING_STORE_PATH = storePath
const { createOnethingBackend } = await import('../../../backend.js')
class Sender extends EventEmitter { isDestroyed() { return false } send() {} }
const backend = await createOnethingBackend({
  host: { storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null },
  sender: new Sender() as never, toolRegistry: 'headless',
})
const stores = await import('../../../stores/sessions.js')
const initialOwner = { userId: 'alice', workspaceId: 'tenant' }
stores.createSession(parentId, 'parent', { workspaceId: 'product-space', initialOwner })
if (mode === 'create') process.exit(73)
stores.createBranchSession(childId, 'child', parentId, 'branch-point', [])
if (mode === 'branch') process.exit(73)
await stores.flushAllPendingSaves()
await backend.journalStore.flush()
const rename = fs.renameSync
fs.renameSync = ((from, to) => {
  rename(from, to)
  if (String(to).endsWith(path.join('resources', `${parentId}.directory`))) process.exit(73)
}) as typeof fs.renameSync
const { dispatchRpc } = await import('../../../rpc/registry.js')
const result = await dispatchRpc({ domain: 'sessions', method: 'delete', payload: { sessionId: parentId } }, {
  transport: 'ipc', ownerUid: initialOwner.userId, workspaceId: initialOwner.workspaceId,
})
throw new Error(`The expected deletion crash was not reached: ${JSON.stringify(result)}`)
}
void main().catch(error => { console.error(error); process.exit(1) })
