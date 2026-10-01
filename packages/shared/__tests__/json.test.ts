import { describe, expect, it } from 'vitest'

import {
  isJsonObject,
  parseJsonObject,
  toJsonObject,
  toJsonSchemaObject,
  toJsonValue,
} from '../json.js'
import type {
  JsonArray,
  JsonObject,
  JsonObjectProperty,
  JsonPrimitive,
  JsonSchemaObject,
  JsonValue,
} from '../json.js'

describe('core JSON protocol helpers', () => {
  it('exposes JSON protocol types for core consumers', () => {
    const primitive: JsonPrimitive = 'value'
    const property: JsonObjectProperty = primitive
    const array: JsonArray = [property, 1]
    const schema: JsonSchemaObject = { type: 'array', items: { type: 'string' } }
    const value: JsonValue = { array, schema }
    const object: JsonObject = toJsonObject(value)

    expect(object).toEqual({ array: ['value', 1], schema })
  })

  it('sanitizes arbitrary values into JSON-safe values', () => {
    const value = toJsonValue({
      ok: true,
      count: 3,
      empty: null,
      nested: {
        keep: 'yes',
        skip: undefined,
        invalidNumber: Number.NaN,
      },
      list: ['a', undefined, Number.POSITIVE_INFINITY, 7],
      fn: () => 'ignored',
    })

    expect(value).toEqual({
      ok: true,
      count: 3,
      empty: null,
      nested: {
        keep: 'yes',
      },
      list: ['a', 7],
    })
  })

  it('projects non-object values to an empty object', () => {
    expect(toJsonObject('text')).toEqual({})
    expect(toJsonObject(['value'])).toEqual({})
    expect(toJsonObject({ value: 'kept' })).toEqual({ value: 'kept' })
  })

  it('parses only JSON objects', () => {
    expect(parseJsonObject('')).toEqual({})
    expect(parseJsonObject('{"value":true}')).toEqual({ value: true })
    expect(() => parseJsonObject('[1,2]')).toThrow('Expected JSON object')
  })

  it('identifies plain object-shaped JSON values', () => {
    expect(isJsonObject({ value: true })).toBe(true)
    expect(isJsonObject(null)).toBe(false)
    expect(isJsonObject(['value'])).toBe(false)
  })

  it('projects schema-shaped values through the JSON object helper', () => {
    expect(toJsonSchemaObject({
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      extra: undefined,
    })).toEqual({
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    })
  })
})
