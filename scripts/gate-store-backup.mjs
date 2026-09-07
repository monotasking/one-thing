#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Run after npm run build:cli. Every operation uses an isolated directory and
// the actual CLI bundle; this never opens the user's store or starts a daemon.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repo, 'dist/cli/main.cjs')
assert.ok(fs.existsSync(cli), 'Build the CLI before running this gate.')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-store-backup-cli-'))
const source = path.join(temporary, 'source with spaces')
const backup = path.join(temporary, 'complete backup')
const restored = path.join(temporary, 'restored')
const unusedDefault = path.join(temporary, 'must-not-open-default')
function run(args, status = 0) {
  const child = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ONETHING_STORE_PATH: unusedDefault },
  })
  assert.equal(child.status, status, `${args[0]} ${args[1]}: ${child.stderr || child.error || child.stdout}`)
  return child.stdout.trim()
}
try {
  fs.mkdirSync(path.join(source, 'sessions/owned/blobs'), { recursive: true })
  const entries = {
    'sessions/owned/meta.json': JSON.stringify({ id: 'owned', ownerUserId: 'alice', ownerWorkspaceId: 'tenant', storageGeneration: 'first' }),
    'sessions/owned/events.jsonl': '{"seq":1,"fixture":"durable-event"}\n',
    'sessions/owned/blobs/image.bin': Buffer.from([0, 1, 128, 255]),
    'sessions/.deletions/pending/intent.json': '{"version":1,"id":"pending"}',
    'settings.json': '{"fixture":true}\n',
  }
  for (const [name, content] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true })
    fs.writeFileSync(path.join(source, name), content)
  }
  run(['store', 'backup', backup], 1)
  assert.equal(fs.existsSync(unusedDefault), false)
  assert.equal(fs.existsSync(backup), false)
  run(['store', 'backup', backup, '--store', source])
  assert.equal(JSON.parse(run(['store', 'verify', backup])).valid, true)
  const restore = JSON.parse(run(['store', 'restore', backup, restored]))
  assert.equal(restore.staged, true)
  assert.equal(restore.activationStorePath, fs.realpathSync(source))
  for (const name of Object.keys(entries)) assert.deepEqual(fs.readFileSync(path.join(restored, name)), fs.readFileSync(path.join(source, name)))
  assert.deepEqual(fs.readdirSync(path.join(restored, 'run')), [])
  assert.deepEqual(fs.readdirSync(path.join(source, 'run')), [])
  run(['store', 'restore', backup, restored], 1)
  fs.writeFileSync(path.join(backup, 'data/sessions/owned/blobs/image.bin'), 'corrupt')
  run(['store', 'verify', backup], 1)
  const refused = path.join(temporary, 'refused')
  run(['store', 'restore', backup, refused], 1)
  assert.equal(fs.existsSync(refused), false)
  assert.equal(fs.existsSync(unusedDefault), false)
  console.log('PASS: real CLI backup / verify / new-directory restore; corrupt and overwrite refusals; no daemon/default-store access.')
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
