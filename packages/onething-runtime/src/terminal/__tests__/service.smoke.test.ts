/**
 * Real-machine smoke: spawns a REAL zsh through node-pty (no mocks) and
 * drives the full service pipeline — coalescing, ring, attach snapshot.
 * Exercises the native addon + spawn-helper exec bit on this machine.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createNodePtyBackend } from '../pty-backend.js'
import { TerminalService } from '../service.wiring.js'

// The spawned shell is a REAL interactive login zsh. Left alone it would
// source the developer's ~/.zshrc and append the marker commands below to
// the developer's real ~/.zsh_history on every test run (macOS /etc/zshrc
// pins HISTFILE=$ZDOTDIR/.zsh_history unconditionally, so overriding
// HISTFILE alone is not enough). Point ZDOTDIR at a throwaway directory:
// the shell's history lands there and no user rc files are read at all.
const previousZdotdir = process.env.ZDOTDIR
const zdotdir = mkdtempSync(path.join(os.tmpdir(), 'onething-pty-smoke-'))
writeFileSync(path.join(zdotdir, '.zshrc'), '')
process.env.ZDOTDIR = zdotdir

const native = createNodePtyBackend()
const pids: number[] = []
const exited = new Set<number>()
const service = new TerminalService({ spawn(request) {
  const pty = native.spawn(request)
  pids.push(pty.pid)
  pty.onExit(() => exited.add(pty.pid))
  return pty
} }, () => null)

afterAll(async () => {
  await service.killAll()
  if (previousZdotdir === undefined) delete process.env.ZDOTDIR
  else process.env.ZDOTDIR = previousZdotdir
  rmSync(zdotdir, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for terminal output')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function snapshotText(terminalId: string): string {
  const response = service.attach(terminalId)
  return (response.chunks ?? []).map(chunk => chunk.data).join('')
}

describe('TerminalService real-pty smoke', () => {
  it('spawns a real shell, echoes back, and survives attach replay', async () => {
    const info = service.create({ cwd: process.cwd() })
    expect(info.shell.length).toBeGreaterThan(0)

    // Wait for the prompt to be ready-ish, then run a marker command whose
    // output cannot appear from pure echo-back of the input line.
    await new Promise(resolve => setTimeout(resolve, 1200))
    service.write(info.id, 'echo smoke-$((40+2))\r')
    await waitFor(() => snapshotText(info.id).includes('smoke-42'))

    service.write(info.id, 'echo 中文往返测试\r')
    await waitFor(() => snapshotText(info.id).includes('中文往返测试'))

    const attach = service.attach(info.id)
    expect(attach.success).toBe(true)
    expect(attach.info?.cols).toBe(80)
    expect((attach.lastSeq ?? 0)).toBeGreaterThan(0)

    await service.kill(info.id)
    expect(service.list()).toHaveLength(0)
    expect(exited.has(pids[0])).toBe(true)
    expect(() => process.kill(pids[0], 0)).toThrow()
  }, 20000)
})
