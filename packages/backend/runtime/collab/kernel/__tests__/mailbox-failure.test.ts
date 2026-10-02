import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createActorEvent } from '../envelope.js'
import { DurableMailbox, readActorMailboxLog } from '../mailbox.js'

let directory: string
const opened: DurableMailbox[] = []
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-save-failure-')) })
afterEach(async () => {
  opened.splice(0).forEach(mailbox => mailbox.close())
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

function event(id: string) {
  return createActorEvent({ id, at: 1, type: 'probe', from: { kind: 'room', id: 'r' }, to: { kind: 'agent', id: 'a' }, payload: {} })
}

async function open() {
  const mailbox = await DurableMailbox.open({ dir: directory, ownerId: 'a' })
  opened.push(mailbox)
  return mailbox
}

it('retains the first real append failure after a later queued append succeeds', async () => {
  const mailbox = await open()
  await fs.rename(mailbox.logPath, `${mailbox.logPath}.saved`)
  await fs.mkdir(mailbox.logPath)
  const failure = await mailbox.append(event('failed')).catch(error => error)
  expect(failure).toMatchObject({ code: 'EISDIR' })
  await expect(mailbox.flush()).rejects.toBe(failure)
  await fs.rmdir(mailbox.logPath)
  await fs.rename(`${mailbox.logPath}.saved`, mailbox.logPath)
  await mailbox.append(event('saved'))
  expect(mailbox.lastSeq).toBe(1)
  await expect(mailbox.flush()).rejects.toBe(failure)
  expect((await readActorMailboxLog(mailbox.logPath)).map(entry => entry.id)).toEqual(['saved'])
})

it('retains a real cursor save failure even after a later cursor save succeeds', async () => {
  const mailbox = await open()
  await mailbox.append(event('first'))
  await fs.mkdir(mailbox.cursorPath)
  let failure: unknown
  try { mailbox.ack(1) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  await expect(mailbox.flush()).rejects.toBe(failure)
  await fs.rmdir(mailbox.cursorPath)
  await mailbox.append(event('second'))
  mailbox.ack(2)
  expect(JSON.parse(await fs.readFile(mailbox.cursorPath, 'utf8')).seq).toBe(2)
  await expect(mailbox.flush()).rejects.toBe(failure)
})

it('waits for real pending IO before reporting its save failure to flush', async () => {
  const mailbox = await open()
  await fs.rename(mailbox.logPath, `${mailbox.logPath}.saved`)
  await fs.mkdir(mailbox.logPath)
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const appendFile = fs.appendFile.bind(fs)
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
    if (String(args[0]) === mailbox.logPath) { entered(); await held }
    return appendFile(...args)
  })
  const appending = mailbox.append(event('failed')).catch(error => error)
  await started
  let settled = false
  const flushing = mailbox.flush().then(() => { settled = true; return undefined }, error => { settled = true; return error })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
  } finally { release() }
  const failure = await appending
  expect(failure).toMatchObject({ code: 'EISDIR' })
  expect(await flushing).toBe(failure)
})
