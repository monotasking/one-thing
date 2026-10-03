import { describe, expect, it } from 'vitest'
import { projectIdFromPath } from '../id.js'

describe('projectIdFromPath', () => {
  it('returns 16 hex characters', () => {
    expect(projectIdFromPath('/foo/bar')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is stable for the same input', () => {
    expect(projectIdFromPath('/foo')).toBe(projectIdFromPath('/foo'))
  })

  it('differs for different inputs', () => {
    expect(projectIdFromPath('/foo')).not.toBe(projectIdFromPath('/bar'))
  })

  it('normalizes trailing slashes', () => {
    expect(projectIdFromPath('/foo/')).toBe(projectIdFromPath('/foo'))
    expect(projectIdFromPath('/foo///')).toBe(projectIdFromPath('/foo'))
  })

  it('does not expand home path literals', () => {
    expect(projectIdFromPath('~/foo')).not.toBe(projectIdFromPath('/Users/x/foo'))
  })
})
