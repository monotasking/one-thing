import { describe, expect, it } from 'vitest'
import {
  assertNotReserved,
  assertValidName,
  assertValidValue,
  findDuplicateNames,
  isReservedName,
} from '../validation.js'
import { VariableError } from '../types.js'

describe('variable validation', () => {
  it('validates names, reserved names, and values', () => {
    expect(() => assertValidName('good_name1')).not.toThrow()
    expect(() => assertValidName('1bad')).toThrow(VariableError)
    expect(isReservedName('workdir')).toBe(true)
    expect(() => assertNotReserved('workdir')).toThrow(VariableError)
    expect(() => assertValidValue('ok')).not.toThrow()
    expect(() => assertValidValue('x'.repeat(4097))).toThrow(VariableError)
  })

  it('detects duplicate names', () => {
    expect(findDuplicateNames(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b'])
  })
})
