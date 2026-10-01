import { describe, expect, it } from 'vitest'

import { defineRouter, getChannelName } from '../router.js'

describe('core IPC router protocol', () => {
  describe('getChannelName()', () => {
    it('converts camelCase methods to kebab-case channels', () => {
      expect(getChannelName('memory-feedback', 'getStats')).toBe('memory-feedback:get-stats')
    })

    it('keeps lowercase method names unchanged', () => {
      expect(getChannelName('memory-feedback', 'record')).toBe('memory-feedback:record')
    })

    it('handles multiple uppercase letters', () => {
      expect(getChannelName('sessions', 'getTokenUsage')).toBe('sessions:get-token-usage')
    })

    it('handles single-word methods', () => {
      expect(getChannelName('oauth', 'start')).toBe('oauth:start')
    })
  })

  describe('defineRouter()', () => {
    type TestRoutes = {
      getAll: { input: void; output: string[] }
      create: { input: { name: string }; output: { id: string } }
      deleteById: { input: { id: string }; output: void }
    }

    const router = defineRouter<TestRoutes>('test-domain', ['getAll', 'create', 'deleteById'])

    it('sets the domain name', () => {
      expect(router.domain).toBe('test-domain')
    })

    it('generates channel names', () => {
      expect(router.channels.getAll).toBe('test-domain:get-all')
      expect(router.channels.create).toBe('test-domain:create')
      expect(router.channels.deleteById).toBe('test-domain:delete-by-id')
    })

    it('stores method names', () => {
      expect(router.methods).toEqual(['getAll', 'create', 'deleteById'])
    })

    it('freezes the returned object', () => {
      expect(Object.isFrozen(router)).toBe(true)
      expect(Object.isFrozen(router.channels)).toBe(true)
      expect(Object.isFrozen(router.methods)).toBe(true)
    })
  })

  it('preserves legacy channel naming compatibility', () => {
    type TestRoutes = {
      record: { input: { id: string }; output: { success: boolean } }
      getStats: { input: { id: string }; output: { success: boolean } }
    }
    const router = defineRouter<TestRoutes>('test-domain', ['record', 'getStats'])

    expect(router.channels.record).toBe('test-domain:record')
    expect(router.channels.getStats).toBe('test-domain:get-stats')
  })
})
