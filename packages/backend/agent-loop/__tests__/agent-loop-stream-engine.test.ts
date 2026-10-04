import { describe, expect, it } from 'vitest'
import {
  normalizeCoreStreamError,
  resolveStreamPermissionMode,
} from '@onething/backend/agent-loop'
// 错误码说明归各家自己的 manifest,由 provider 注册表加载时经 core 的查询口接进来
// (`configureProviderErrorCodeDescriber`)。core 自己不认识任何一家,所以这里要把注册表载上。
import '../../provider/provider-manifest.js'

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
