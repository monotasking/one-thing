import { describe, expect, it } from 'vitest'
import { createStreamingArgsParser, parseStreamingArgs } from '../streaming-args.js'

const EDIT_ARGS = JSON.stringify({
  edits: [
    { oldText: '| Athens | English_UK |', newText: '| Athens | 中文 |' },
    { oldText: 'iva_config_insert("LA")', newText: 'iva_config_insert("LA", \'*\')' },
  ],
  path: '/Users/x/71.01 需求/IVA/115. IVA Premier+Think-Idea 0810.md',
})

/** Deterministic pseudo-random split points so the property test is replayable. */
function splitPoints(text: string, seed: number): number[] {
  const points: number[] = []
  let value = seed
  let index = 0
  while (index < text.length) {
    value = (value * 1103515245 + 12345) % 2147483648
    index += 1 + (value % 7)
    if (index < text.length) points.push(index)
  }
  return points
}

function feedInChunks(text: string, seed: number) {
  const parser = createStreamingArgsParser()
  let previous = 0
  for (const point of splitPoints(text, seed)) {
    parser.push(text.slice(previous, point))
    previous = point
  }
  parser.push(text.slice(previous))
  return parser.view()
}

describe('createStreamingArgsParser', () => {
  it('parses a complete edit-args payload into closed leaf fields', () => {
    const view = parseStreamingArgs(EDIT_ARGS)
    expect(view.complete).toBe(true)
    expect(view.openPath).toBeNull()
    expect(view.error).toBeUndefined()
    expect(view.fields.map(field => [field.path, field.state])).toEqual([
      ['edits[0].oldText', 'closed'],
      ['edits[0].newText', 'closed'],
      ['edits[1].oldText', 'closed'],
      ['edits[1].newText', 'closed'],
      ['path', 'closed'],
    ])
    expect(view.fields.at(-1)?.value).toContain('115. IVA Premier+Think-Idea 0810.md')
  })

  it('is split-invariant: any chunking yields the same final view', () => {
    const whole = parseStreamingArgs(EDIT_ARGS)
    for (let seed = 1; seed <= 25; seed++) {
      expect(feedInChunks(EDIT_ARGS, seed)).toEqual(whole)
    }
  })

  it('marks the streaming field open with its decoded prefix and mounts the cursor there', () => {
    const parser = createStreamingArgsParser()
    parser.push('{"edits": [{"oldText": "abc def')
    const view = parser.view()
    expect(view.complete).toBe(false)
    expect(view.openPath).toBe('edits[0].oldText')
    expect(view.fields).toEqual([
      { path: 'edits[0].oldText', state: 'open', value: 'abc def', kind: 'string' },
    ])
  })

  it('closed fields stay settled while the next value streams', () => {
    const parser = createStreamingArgsParser()
    parser.push('{"a": "done", "b": "par')
    const view = parser.view()
    expect(view.fields).toEqual([
      { path: 'a', state: 'closed', value: 'done', kind: 'string' },
      { path: 'b', state: 'open', value: 'par', kind: 'string' },
    ])
    expect(view.openPath).toBe('b')
  })

  it('withholds incomplete escape sequences from the decoded value', () => {
    const parser = createStreamingArgsParser()
    parser.push('{"s": "line1\\')
    expect(parser.view().fields[0].value).toBe('line1')
    parser.push('n')
    expect(parser.view().fields[0].value).toBe('line1\n')
    parser.push('\\u4e')
    expect(parser.view().fields[0].value).toBe('line1\n')
    parser.push('2d')
    expect(parser.view().fields[0].value).toBe('line1\n中')
  })

  it('withholds a lone high surrogate until its partner arrives', () => {
    const parser = createStreamingArgsParser()
    parser.push('{"s": "\\ud83d')
    expect(parser.view().fields[0].value).toBe('')
    parser.push('\\ude00')
    expect(parser.view().fields[0].value).toBe('😀')
  })

  it('handles numbers, booleans, null, and empty containers', () => {
    const view = parseStreamingArgs('{"n": -1.5e3, "t": true, "z": null, "o": {}, "a": []}')
    expect(view.complete).toBe(true)
    expect(view.fields).toEqual([
      { path: 'n', state: 'closed', value: '-1.5e3', kind: 'number' },
      { path: 't', state: 'closed', value: 'true', kind: 'boolean' },
      { path: 'z', state: 'closed', value: 'null', kind: 'null' },
    ])
  })

  it('reports charsReceived as the exact pushed length', () => {
    const parser = createStreamingArgsParser()
    parser.push('{"a": "xy')
    parser.push('z"}')
    expect(parser.view().charsReceived).toBe('{"a": "xyz"}'.length)
  })

  it('never throws on malformed input and keeps the last good fields', () => {
    const parser = createStreamingArgsParser()
    parser.push('{"a": "ok", "b": ??')
    const view = parser.view()
    expect(view.error).toBeTruthy()
    expect(view.openPath).toBeNull()
    expect(view.fields[0]).toEqual({ path: 'a', state: 'closed', value: 'ok', kind: 'string' })
  })

  it('treats a top-level non-object as complete-when-closed (arrays)', () => {
    const view = parseStreamingArgs('["x", "y"]')
    expect(view.complete).toBe(true)
    expect(view.fields.map(field => field.path)).toEqual(['[0]', '[1]'])
  })
})
