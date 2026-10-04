import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OnethingTokenStore,
  type OnethingTokenCryptoAdapter,
} from '../auth.js'
import type { OnethingOAuthToken } from '../auth-types.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function createTokenFilePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-token-store-'))
  dirs.push(dir)
  return path.join(dir, 'oauth-tokens.json')
}

function createToken(overrides: Partial<OnethingOAuthToken> = {}): OnethingOAuthToken {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 2_000,
    tokenType: 'Bearer',
    scope: 'read',
    ...overrides,
  }
}

describe('onething runtime token store(单槽旧文件,批 8 起只读)', () => {
  it('reads plaintext tokens, lists providers and judges expiry without host dependencies', async () => {
    const tokenFilePath = await createTokenFilePath()
    const token = createToken()
    await fs.writeFile(tokenFilePath, JSON.stringify({ codex: JSON.stringify(token) }))
    const store = new OnethingTokenStore({
      tokenFilePath,
      now: () => 1_000,
    })

    await expect(store.getToken('codex')).resolves.toEqual(token)
    await expect(store.listProviderIds()).resolves.toEqual(['codex'])
    await expect(store.isReadable('codex')).resolves.toBe(true)
    expect(store.isTokenExpired(token)).toBe(false)
    expect(store.isTokenExpired(createToken({ expiresAt: 999 }))).toBe(true)
  })

  it('写路已删:单槽不再有 saveToken / deleteToken', () => {
    const store = new OnethingTokenStore({ tokenFilePath: '/nonexistent/oauth-tokens.json' }) as unknown as Record<string, unknown>
    expect(store.saveToken).toBeUndefined()
    expect(store.deleteToken).toBeUndefined()
  })

  it('uses an injected crypto adapter instead of importing Electron', async () => {
    const tokenFilePath = await createTokenFilePath()
    const cryptoAdapter: OnethingTokenCryptoAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from(`encrypted:${text}`),
      decryptString: buffer => {
        const text = buffer.toString('utf-8')
        if (!text.startsWith('encrypted:')) {
          throw new Error('Unexpected encrypted token payload')
        }
        return text.slice('encrypted:'.length)
      },
    }
    const token = createToken({ accessToken: 'encrypted-access-token' })
    await fs.writeFile(tokenFilePath, JSON.stringify({
      codex: Buffer.from(`encrypted:${JSON.stringify(token)}`).toString('base64'),
    }))
    const store = new OnethingTokenStore({
      tokenFilePath,
      cryptoAdapter,
    })

    await expect(store.getToken('codex')).resolves.toEqual(token)
    await expect(store.isReadable('codex')).resolves.toBe(true)
    // 同一份密文,没有加密器的宿主读不出来 —— 归位据此推迟,而不是把它当空。
    const blind = new OnethingTokenStore({ tokenFilePath })
    await expect(blind.isReadable('codex')).resolves.toBe(false)
  })

  it('reads legacy plaintext tokens and restores the default token type', async () => {
    const tokenFilePath = await createTokenFilePath()
    await fs.writeFile(tokenFilePath, JSON.stringify({
      codex: JSON.stringify({
        accessToken: 'legacy-access-token',
        expiresAt: 3_000,
      }),
    }))

    const store = new OnethingTokenStore({ tokenFilePath })

    await expect(store.getToken('codex')).resolves.toMatchObject({
      accessToken: 'legacy-access-token',
      expiresAt: 3_000,
      tokenType: 'Bearer',
    })
  })

  it('returns null and warns when an encrypted token cannot be decoded', async () => {
    const tokenFilePath = await createTokenFilePath()
    await fs.writeFile(tokenFilePath, JSON.stringify({
      codex: Buffer.from('not-json').toString('base64'),
    }))
    const warn = vi.fn()
    const store = new OnethingTokenStore({
      tokenFilePath,
      cryptoAdapter: {
        isEncryptionAvailable: () => true,
        encryptString: text => Buffer.from(text),
        decryptString: () => 'not-json',
      },
      logger: { warn },
    })

    await expect(store.getToken('codex')).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})
