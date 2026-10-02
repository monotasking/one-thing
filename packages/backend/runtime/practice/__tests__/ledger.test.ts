import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OnethingPracticeLedger, onethingPracticeLedgerFileName } from '../ledger.js'

describe('OnethingPracticeLedger', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-practice-ledger-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('appends records with generated ids into a per-month JSONL file', async () => {
    const ledger = new OnethingPracticeLedger({ ledgerDir: dir })
    const ts = new Date(2026, 6, 18, 21, 0).getTime()
    const record = ledger.record({
      ts,
      kind: 'kegel',
      source: 'timer',
      name: '凯格尔',
      kegel: { holdSec: 10, relaxSec: 5, repsDone: 40, repsTarget: 20, setsDone: 2, setsTarget: 3 },
    })
    await ledger.flush()

    expect(record.id).toMatch(/^p_/)
    const filePath = path.join(dir, onethingPracticeLedgerFileName(ts))
    expect(fs.existsSync(filePath)).toBe(true)
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.kind).toBe('kegel')
    expect(parsed.kegel.repsDone).toBe(40)
  })

  it('skips bad lines when reading', async () => {
    const ledger = new OnethingPracticeLedger({ ledgerDir: dir })
    const ts = new Date(2026, 6, 18).getTime()
    ledger.record({ ts, kind: 'exercise', source: 'manual', name: '俯卧撑', exercise: { sets: 3, repsPerSet: 20 } })
    await ledger.flush()
    const filePath = path.join(dir, onethingPracticeLedgerFileName(ts))
    fs.appendFileSync(filePath, 'not json\n{"kind":"unknown","ts":1,"name":"x"}\n{"ts":"nope"}\n')

    const records = await ledger.readRecordsInRange(0, Date.now() + 86400000)
    expect(records).toHaveLength(1)
    expect(records[0].name).toBe('俯卧撑')
  })

  it('reads across monthly files and filters by [start, end)', async () => {
    const ledger = new OnethingPracticeLedger({ ledgerDir: dir })
    const junTs = new Date(2026, 5, 15).getTime()
    const julTs = new Date(2026, 6, 13).getTime()
    const augTs = new Date(2026, 7, 2).getTime()
    for (const ts of [junTs, julTs, augTs]) {
      ledger.record({ ts, kind: 'pomodoro', source: 'timer', name: '学习', pomodoro: { minutes: 25, elapsedMin: 25, completed: true } })
    }
    await ledger.flush()

    expect(fs.existsSync(path.join(dir, onethingPracticeLedgerFileName(junTs)))).toBe(true)
    expect(fs.existsSync(path.join(dir, onethingPracticeLedgerFileName(augTs)))).toBe(true)

    const records = await ledger.readRecordsInRange(junTs + 1, augTs)
    expect(records).toHaveLength(1)
    expect(records[0].ts).toBe(julTs)
  })

  it('returns empty when the ledger dir does not exist', async () => {
    const ledger = new OnethingPracticeLedger({ ledgerDir: path.join(dir, 'missing') })
    const records = await ledger.readRecordsInRange(0, Date.now())
    expect(records).toEqual([])
  })

  it('serializes queued appends in arrival order', async () => {
    const ledger = new OnethingPracticeLedger({ ledgerDir: dir })
    const ts = new Date(2026, 6, 18).getTime()
    for (let i = 0; i < 5; i++) {
      ledger.record({ ts: ts + i, kind: 'exercise', source: 'agent', name: `e${i}` })
    }
    await ledger.flush()
    const records = await ledger.readRecordsInRange(ts, ts + 10)
    expect(records.map(r => r.name)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
  })
})
