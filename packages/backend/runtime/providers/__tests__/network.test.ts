import { describe, expect, it } from 'vitest'
import {
  getOnethingNetworkDispatcherCacheKey,
  normalizeOnethingProxySettings,
  shouldBypassOnethingProxy,
  splitOnethingProxyBypassRules,
  validateOnethingProxyUrl,
} from '../network.js'

describe('onething network provider helpers', () => {
  it('validates and normalizes supported proxy URLs', () => {
    expect(validateOnethingProxyUrl(' http://127.0.0.1:7890 ').valid).toBe(true)
    expect(validateOnethingProxyUrl('https://proxy.example.com:8443').valid).toBe(true)
    expect(validateOnethingProxyUrl('socks5://127.0.0.1:7890').valid).toBe(true)

    expect(validateOnethingProxyUrl('').valid).toBe(false)
    expect(validateOnethingProxyUrl('not a url').valid).toBe(false)
    expect(validateOnethingProxyUrl('ftp://127.0.0.1:21').valid).toBe(false)
  })

  it('normalizes enabled proxy settings', () => {
    expect(normalizeOnethingProxySettings({
      enabled: true,
      url: ' http://127.0.0.1:7890 ',
      bypassRules: 'localhost',
    })).toMatchObject({
      enabled: true,
      url: 'http://127.0.0.1:7890/',
      bypassRules: 'localhost',
    })

    expect(normalizeOnethingProxySettings({ enabled: false, url: '' })).toBeUndefined()
  })

  it('matches proxy bypass rules consistently across hosts', () => {
    const rules = 'localhost;127.0.0.1;::1;*.local;<local>;api.*'

    expect(splitOnethingProxyBypassRules(rules)).toEqual([
      'localhost',
      '127.0.0.1',
      '::1',
      '*.local',
      '<local>',
      'api.*',
    ])
    expect(shouldBypassOnethingProxy('http://localhost:3000', rules)).toBe(true)
    expect(shouldBypassOnethingProxy('http://127.0.0.1:3000', rules)).toBe(true)
    expect(shouldBypassOnethingProxy('http://app.local', rules)).toBe(true)
    expect(shouldBypassOnethingProxy('http://intranet', rules)).toBe(true)
    expect(shouldBypassOnethingProxy('https://api.openai.com/v1', rules)).toBe(true)
    expect(shouldBypassOnethingProxy('https://chatgpt.com/backend-api', rules)).toBe(false)
  })

  it('keeps dispatcher cache keys in runtime', () => {
    expect(getOnethingNetworkDispatcherCacheKey(undefined)).toBe('direct')
    expect(getOnethingNetworkDispatcherCacheKey({
      enabled: true,
      url: 'http://proxy.example.com:7890',
      bypassRules: 'localhost',
    })).toBe('proxy#http://proxy.example.com:7890#localhost')
  })
})
