import { describe, expect, it } from 'vitest'
import { readGatewayPermissionConfigFromEnv } from '../config.js'

describe('gateway config', () => {
  it('defaults gateway permissions to remote approval with a five minute timeout', () => {
    expect(readGatewayPermissionConfigFromEnv({})).toEqual({
      mode: 'remote-approval',
      timeoutMs: 300_000,
    })
  })

  it('reads automatic permission mode and timeout from env', () => {
    expect(readGatewayPermissionConfigFromEnv({
      GATEWAY_PERMISSION_MODE: 'auto-accept-edits',
      GATEWAY_PERMISSION_TIMEOUT_MS: '30000',
    })).toEqual({
      mode: 'auto-accept-edits',
      timeoutMs: 30_000,
    })
  })

  it('rejects unsupported permission modes', () => {
    expect(() => readGatewayPermissionConfigFromEnv({
      GATEWAY_PERMISSION_MODE: 'approve-everything',
    })).toThrow('Unsupported GATEWAY_PERMISSION_MODE')
  })
})
