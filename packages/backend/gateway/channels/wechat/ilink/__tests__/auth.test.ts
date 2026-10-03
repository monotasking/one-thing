import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalStorePath = process.env.ONETHING_STORE_PATH
const tempRoots: string[] = []

afterEach(() => {
  if (originalStorePath === undefined) {
    delete process.env.ONETHING_STORE_PATH
  } else {
    process.env.ONETHING_STORE_PATH = originalStorePath
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  vi.resetModules()
})

describe('WeChat auth storage', () => {
  it('isolates token and sync state per local account id', async () => {
    const root = useTempStore()
    const {
      getWechatAccountStorage,
      loadAuthState,
      loadGetUpdatesBuf,
      saveAuthState,
      saveGetUpdatesBuf,
    } = await import('../auth.js')

    await saveAuthState({
      botToken: 'default-token',
      baseUrl: 'https://default.weixin.example',
      ilinkUserId: 'default-user',
      ilinkBotId: 'default-bot',
    })
    await saveAuthState({
      botToken: 'work-token',
      baseUrl: 'https://work.weixin.example',
      ilinkUserId: 'work-user',
      ilinkBotId: 'work-bot',
    }, 'work')
    saveGetUpdatesBuf('default-sync')
    saveGetUpdatesBuf('work-sync', 'work')

    expect(await loadAuthState()).toMatchObject({
      botToken: 'default-token',
      baseUrl: 'https://default.weixin.example',
      ilinkUserId: 'default-user',
      ilinkBotId: 'default-bot',
    })
    expect(await loadAuthState('work')).toMatchObject({
      botToken: 'work-token',
      baseUrl: 'https://work.weixin.example',
      ilinkUserId: 'work-user',
      ilinkBotId: 'work-bot',
    })
    expect(loadGetUpdatesBuf()).toBe('default-sync')
    expect(loadGetUpdatesBuf('work')).toBe('work-sync')
    expect(getWechatAccountStorage().tokenPath)
      .toBe(path.join(root, 'gateway', 'wechat-accounts', 'default', 'token.json'))
    expect(getWechatAccountStorage('work').syncPath)
      .toBe(path.join(root, 'gateway', 'wechat-accounts', 'work', 'sync.json'))
  })

  it('falls back to legacy single-account files for the default account only', async () => {
    const root = useTempStore()
    const legacyTokenPath = path.join(root, 'gateway', 'wechat-token.json')
    const legacySyncPath = path.join(root, 'gateway', 'wechat-sync.json')
    fs.mkdirSync(path.dirname(legacyTokenPath), { recursive: true })
    fs.writeFileSync(legacyTokenPath, JSON.stringify({
      bot_token: 'legacy-token',
      baseurl: 'https://legacy.weixin.example',
      ilink_user_id: 'legacy-user',
      ilink_bot_id: 'legacy-bot',
    }), 'utf-8')
    fs.writeFileSync(legacySyncPath, JSON.stringify({
      get_updates_buf: 'legacy-sync',
    }), 'utf-8')

    const {
      loadAuthState,
      loadGetUpdatesBuf,
    } = await import('../auth.js')

    expect(await loadAuthState('default')).toMatchObject({
      botToken: 'legacy-token',
      baseUrl: 'https://legacy.weixin.example',
      ilinkUserId: 'legacy-user',
      ilinkBotId: 'legacy-bot',
    })
    expect(loadGetUpdatesBuf('default')).toBe('legacy-sync')
    expect(await loadAuthState('work')).toBeNull()
    expect(loadGetUpdatesBuf('work')).toBe('')
  })
})

function useTempStore(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-wechat-auth-'))
  tempRoots.push(root)
  process.env.ONETHING_STORE_PATH = root
  vi.resetModules()
  return root
}
