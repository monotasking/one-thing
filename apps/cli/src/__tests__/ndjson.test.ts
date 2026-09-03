import { describe, expect, it } from 'vitest'
import { NdjsonReader, encodeFrame } from '../ndjson.js'

describe('NdjsonReader', () => {
  it('parses frames split across chunks', () => {
    const values: unknown[] = []
    const reader = new NdjsonReader(value => values.push(value), error => {
      throw error
    })

    const encoded = encodeFrame({ id: '1', type: 'result', data: { ok: true } })
    reader.push(Buffer.from(encoded.slice(0, 8)))
    reader.push(Buffer.from(encoded.slice(8)))

    expect(values).toEqual([{ id: '1', type: 'result', data: { ok: true } }])
  })
})
