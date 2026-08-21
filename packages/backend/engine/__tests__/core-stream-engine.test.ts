import { describe, expect, it } from 'vitest'
import {
  normalizeCoreStreamError,
  resolveStreamPermissionMode,
} from '@onething/core/engine'

describe('core stream engine helpers', () => {
  it('resolves permission mode from session, settings, then default fallback', () => {
    expect(resolveStreamPermissionMode(
      { permissionMode: 'bypassPermissions' },
      { tools: { permissionMode: 'normal' } },
    )).toBe('bypassPermissions')

    expect(resolveStreamPermissionMode(
      {},
      { tools: { permissionMode: 'auto-accept-edits' } },
    )).toBe('auto-accept-edits')

    expect(resolveStreamPermissionMode(
      undefined,
      { tools: {} },
    )).toBe('normal')

    expect(resolveStreamPermissionMode(
      undefined,
      undefined,
      'ask',
    )).toBe('ask')
  })

  it('normalizes stream errors with provider details in core', () => {
    const error = Object.assign(new Error('Provider failed'), {
      responseBody: JSON.stringify({ error: { message: 'invalid api key' } }),
    })
    expect(normalizeCoreStreamError(error)).toMatchObject({
      error,
      message: 'Provider failed',
      details: 'invalid api key',
      isAbortError: false,
    })

    const zhipuError = Object.assign(new Error('zhipu agent loop API error'), {
      responseBody: JSON.stringify({ error: { code: '1000', message: '身份验证失败。' } }),
    })
    expect(normalizeCoreStreamError(zhipuError).details).toContain('普通 API Key 请使用 Standard 模式')

    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(normalizeCoreStreamError(abort)).toMatchObject({
      message: 'aborted',
      isAbortError: true,
    })
  })
})
