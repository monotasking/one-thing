import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeDurableJson } from '../durable-json.js'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-durable-json-')) })
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('preserves the original fsync failure when removing its temporary file also fails', () => {
  const saveError = Object.assign(new Error('storage device failed'), { code: 'EIO' })
  const cleanupError = Object.assign(new Error('temporary cleanup denied'), { code: 'EACCES' })
  const unlink = fs.unlinkSync
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw saveError })
  vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file).startsWith(directory + path.sep)) throw cleanupError
    return unlink(file)
  })
  const target = path.join(directory, 'state.json')
  expect(() => writeDurableJson(target, { version: 1 })).toThrow(saveError)
  expect(fs.existsSync(target)).toBe(false)
})

it('preserves the original fsync failure when closing the writable handle also fails', () => {
  const saveError = Object.assign(new Error('storage device failed'), { code: 'EIO' })
  const closeError = Object.assign(new Error('close reported an I/O error'), { code: 'EIO' })
  const close = fs.closeSync
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw saveError })
  vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
    close(fd)
    throw closeError
  })
  const target = path.join(directory, 'state.json')
  expect(() => writeDurableJson(target, { version: 1 })).toThrow(saveError)
  expect(fs.existsSync(target)).toBe(false)
})

it('still reports a close failure after an otherwise successful file write', () => {
  const closeError = Object.assign(new Error('close failed'), { code: 'EIO' })
  const close = fs.closeSync
  vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
    close(fd)
    throw closeError
  })
  const target = path.join(directory, 'state.json')
  expect(() => writeDurableJson(target, { version: 1 })).toThrow(closeError)
  expect(fs.existsSync(target)).toBe(false)
})

it('publishes a complete replacement after flushing the file and its metadata', () => {
  const target = path.join(directory, 'state.json')
  writeDurableJson(target, { version: 1, payload: 'before' })
  writeDurableJson(target, { version: 2, payload: 'after' })
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ version: 2, payload: 'after' })
  expect(fs.readdirSync(directory)).toEqual(['state.json'])
})
