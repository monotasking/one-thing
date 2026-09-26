import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeShellConfigFingerprint,
  defaultLoginShellEnvCachePath,
  hydrateProcessEnvFromLoginShell,
  isLauncherOwnedEnvKey,
  loginShellSeedEnv,
  mergeMissingEnv,
  mergePathEnv,
  parseLoginShellEnvOutput,
} from '../login-shell-env.js'

describe('login shell environment helpers', () => {
  it('parses env output after the marker and ignores shell startup noise', () => {
    const output = [
      'startup banner that should be ignored\n',
      '\0__ONETHING_LOGIN_SHELL_ENV_START__\0',
      'OPENAI_API_KEY=from-shell\0',
      'VALUE_WITH_EQUALS=a=b=c\0',
      'not an env var\0',
      '1INVALID=ignored\0',
    ].join('')

    expect(parseLoginShellEnvOutput(output)).toEqual({
      OPENAI_API_KEY: 'from-shell',
      VALUE_WITH_EQUALS: 'a=b=c',
    })
  })

  it('unions PATH, which "merge if missing" can never repair', () => {
    // launchd always hands a GUI-launched app this PATH, so PATH is never
    // "missing" — which is exactly why a double-clicked build could not see
    // Homebrew/nvm binaries while a terminal-launched dev run could.
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

    expect(mergePathEnv(target, { PATH: '/opt/homebrew/bin:/usr/bin:/bin' })).toBe(true)

    // Login shell first (its order is the user's intent), inherited entries
    // kept (we may only ever add a resolvable command, never remove one).
    expect(target.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('leaves PATH alone when the login shell adds nothing new', () => {
    // The terminal-launched case: PATH is already the shell's, so this is a
    // no-op rather than a reshuffle.
    const target: NodeJS.ProcessEnv = { PATH: '/opt/homebrew/bin:/usr/bin' }

    expect(mergePathEnv(target, { PATH: '/opt/homebrew/bin:/usr/bin' })).toBe(false)
    expect(target.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('keeps the inherited PATH when the login shell reports none', () => {
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    expect(mergePathEnv(target, { HOME: '/Users/someone' })).toBe(false)
    expect(target.PATH).toBe('/usr/bin:/bin')
  })

  it('merges only missing env vars into the current process env', () => {
    const target: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: 'from-parent',
      EMPTY_ENV: '',
    }

    const merged = mergeMissingEnv(target, {
      OPENAI_API_KEY: 'from-shell',
      ANTHROPIC_API_KEY: 'anthropic-shell',
      EMPTY_ENV: 'filled-shell',
      BLANK_IGNORED: '',
    })

    expect(merged).toEqual(['ANTHROPIC_API_KEY', 'EMPTY_ENV'])
    expect(target).toMatchObject({
      OPENAI_API_KEY: 'from-parent',
      ANTHROPIC_API_KEY: 'anthropic-shell',
      EMPTY_ENV: 'filled-shell',
    })
    expect(target.BLANK_IGNORED).toBeUndefined()
  })

  /*
   * 09-26 事故(文件头):一台门以 `ONETHING_STORE_PATH=<临时目录>` 起壳,那句被抓进
   * 缓存,用户下一次起桌面整台后端装进了空临时目录。「这个进程住哪、怎么起的」是
   * 启动者的话,登录 shell 与它的缓存永远不许补。
   */
  it('never injects launcher-owned keys (ONETHING_* / npm_* / ELECTRON_*) even when missing', () => {
    const target: NodeJS.ProcessEnv = {}
    const merged = mergeMissingEnv(target, {
      ONETHING_STORE_PATH: '/var/folders/x/T/pv-squeeze-store-abc',
      ONETHING_GATE_HEADLESS: '1',
      ONETHING_REACT_DEV_SERVER_URL: 'http://127.0.0.1:5194/',
      npm_config_user_agent: 'npm/10',
      ELECTRON_RUN_AS_NODE: '1',
      OPENAI_API_KEY: 'from-shell',
    })
    expect(merged).toEqual(['OPENAI_API_KEY'])
    expect(target.ONETHING_STORE_PATH).toBeUndefined()
    expect(target.ONETHING_GATE_HEADLESS).toBeUndefined()
    expect(target.ONETHING_REACT_DEV_SERVER_URL).toBeUndefined()
    expect(target.npm_config_user_agent).toBeUndefined()
    expect(target.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(isLauncherOwnedEnvKey('ONETHING_LOG')).toBe(true)
    expect(isLauncherOwnedEnvKey('ANTHROPIC_API_KEY')).toBe(false)
  })

  it('seeds the login shell with identity and locale only, never the launcher\'s variables', () => {
    const seed = loginShellSeedEnv({
      HOME: '/Users/me',
      USER: 'me',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp',
      ONETHING_STORE_PATH: '/var/folders/x/T/pv-squeeze-store-abc',
      ONETHING_GATE_HEADLESS: '1',
      OPENAI_API_KEY: 'parent-secret',
      npm_lifecycle_event: 'electron:dev',
      EMPTY: '',
    })
    expect(seed).toEqual({
      HOME: '/Users/me',
      USER: 'me',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp',
    })
  })

  it('keeps the cache beside the store the process was launched on', () => {
    expect(defaultLoginShellEnvCachePath({ ONETHING_STORE_PATH: '/tmp/gate-store' }))
      .toBe(path.join('/tmp/gate-store', 'login-shell-env.json'))
    expect(defaultLoginShellEnvCachePath({}))
      .toBe(path.join(os.homedir(), '.onething', 'login-shell-env.json'))
  })
})

describe('login shell environment cache', () => {
  const tempDirs: string[] = []

  function createTempCachePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-login-env-'))
    tempDirs.push(dir)
    return path.join(dir, 'login-shell-env.json')
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hydrates synchronously from a fingerprint-matched cache without spawning a shell', async () => {
    const cachePath = createTempCachePath()
    // shell 指向不存在的路径:若走了慢路径(spawn),结果必为空;
    // 只有缓存命中才能注入 FROM_CACHE。
    const shell = '/nonexistent/fake-zsh'
    fs.writeFileSync(cachePath, JSON.stringify({
      fingerprint: computeShellConfigFingerprint(shell),
      env: { FROM_CACHE: 'cached-value' },
    }))

    const targetEnv: NodeJS.ProcessEnv = { SHELL: shell }
    const merged = await hydrateProcessEnvFromLoginShell({
      env: targetEnv,
      shell,
      platform: 'darwin',
      cacheFilePath: cachePath,
      disableBackgroundRefresh: true,
    })

    expect(merged).toEqual(['FROM_CACHE'])
    expect(targetEnv.FROM_CACHE).toBe('cached-value')
  })

  it('repairs a launchd PATH so a packaged app can find Homebrew/nvm binaries', async () => {
    // The whole point of hydrating: a double-clicked app gets launchd's PATH,
    // so `ncm-cli`, `rg`, `uv` and friends are simply not there. It only ever
    // showed up in packaged builds — a dev run inherits the terminal's PATH,
    // where this is a no-op.
    const cachePath = createTempCachePath()
    const shell = '/nonexistent/fake-zsh'
    fs.writeFileSync(cachePath, JSON.stringify({
      fingerprint: computeShellConfigFingerprint(shell),
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    }))

    const targetEnv: NodeJS.ProcessEnv = { SHELL: shell, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
    const merged = await hydrateProcessEnvFromLoginShell({
      env: targetEnv,
      shell,
      platform: 'darwin',
      cacheFilePath: cachePath,
      disableBackgroundRefresh: true,
    })

    expect(merged).toEqual(['PATH'])
    expect(targetEnv.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('ignores a cache whose shell config fingerprint no longer matches', async () => {
    const cachePath = createTempCachePath()
    const shell = '/nonexistent/fake-zsh'
    const staleFingerprint = computeShellConfigFingerprint(shell)
    staleFingerprint.configMtimes['/etc/zshrc'] = 12345
    fs.writeFileSync(cachePath, JSON.stringify({
      fingerprint: staleFingerprint,
      env: { FROM_CACHE: 'stale' },
    }))

    const targetEnv: NodeJS.ProcessEnv = {}
    const merged = await hydrateProcessEnvFromLoginShell({
      env: targetEnv,
      shell,
      platform: 'darwin',
      cacheFilePath: cachePath,
      disableBackgroundRefresh: true,
    })

    // 指纹不符 → 慢路径;shell 不存在 → 失败返回空,且不注入过期缓存。
    expect(merged).toEqual([])
    expect(targetEnv.FROM_CACHE).toBeUndefined()
  })

  it('writes the cache after a slow-path read and hits it on the next run', async () => {
    const cachePath = createTempCachePath()
    const targetEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    const merged = await hydrateProcessEnvFromLoginShell({
      env: targetEnv,
      shell: '/bin/sh',
      platform: 'darwin',
      cacheFilePath: cachePath,
      disableBackgroundRefresh: true,
    })
    expect(Array.isArray(merged)).toBe(true)
    expect(fs.existsSync(cachePath)).toBe(true)
    expect(fs.statSync(cachePath).mode & 0o777).toBe(0o600)

    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    expect(cached.fingerprint.shell).toBe('/bin/sh')
    expect(typeof cached.env).toBe('object')

    // 第二次:破坏 shell 路径也能命中缓存(证明没有再 spawn)。
    const secondEnv: NodeJS.ProcessEnv = {}
    fs.writeFileSync(cachePath, JSON.stringify({
      fingerprint: computeShellConfigFingerprint('/bin/sh'),
      env: { SECOND_RUN: 'hit' },
    }))
    const secondMerged = await hydrateProcessEnvFromLoginShell({
      env: secondEnv,
      shell: '/bin/sh',
      platform: 'darwin',
      cacheFilePath: cachePath,
      disableBackgroundRefresh: true,
    })
    expect(secondMerged).toEqual(['SECOND_RUN'])
  })

  /*
   * 反证 09-26 事故的三条腿:①真起一次 shell,启动者递的变量不会出现在抓回的缓存里;
   * ②就算缓存里已经躺着一句 `ONETHING_STORE_PATH`(老法抓的、或别人写的),也注不进来;
   * ③版本 1 的缓存(整份进程环境当底抓的)一律不命中。
   */
  it('a launcher-injected ONETHING_STORE_PATH never reaches the cache the shell writes', async () => {
    const cachePath = createTempCachePath()
    const targetEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ONETHING_STORE_PATH: '/var/folders/x/T/pv-squeeze-store-abc',
      LEAKED_BY_LAUNCHER: 'should-not-be-captured',
    }
    await hydrateProcessEnvFromLoginShell({
      env: targetEnv,
      shell: '/bin/sh',
      platform: 'darwin',
      cacheFilePath: cachePath,
      disableBackgroundRefresh: true,
    })
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    expect(cached.fingerprint.version).toBe(2)
    expect(cached.env.ONETHING_STORE_PATH).toBeUndefined()
    expect(cached.env.LEAKED_BY_LAUNCHER).toBeUndefined()
    expect(cached.env.HOME).toBe(process.env.HOME)
  })

  it('a poisoned cache cannot relocate the store or point the shell at another dev server', async () => {
    const cachePath = createTempCachePath()
    const shell = '/nonexistent/fake-zsh'
    fs.writeFileSync(cachePath, JSON.stringify({
      fingerprint: computeShellConfigFingerprint(shell),
      env: {
        ONETHING_STORE_PATH: '/var/folders/x/T/pv-squeeze-store-abc',
        ONETHING_REACT_DEV_SERVER_URL: 'http://127.0.0.1:5194/',
        ONETHING_GATE_HEADLESS: '1',
        HARMLESS: 'ok',
      },
    }))
    const targetEnv: NodeJS.ProcessEnv = { SHELL: shell }
    const merged = await hydrateProcessEnvFromLoginShell({
      env: targetEnv,
      shell,
      platform: 'darwin',
      cacheFilePath: cachePath,
      disableBackgroundRefresh: true,
    })
    expect(merged).toEqual(['HARMLESS'])
    expect(targetEnv.ONETHING_STORE_PATH).toBeUndefined()
    expect(targetEnv.ONETHING_REACT_DEV_SERVER_URL).toBeUndefined()
    expect(targetEnv.ONETHING_GATE_HEADLESS).toBeUndefined()
  })

  it('ignores a version-1 cache captured with the whole process env as its base', async () => {
    const cachePath = createTempCachePath()
    const shell = '/nonexistent/fake-zsh'
    fs.writeFileSync(cachePath, JSON.stringify({
      fingerprint: { ...computeShellConfigFingerprint(shell), version: 1 },
      env: { FROM_OLD_CACHE: 'stale' },
    }))
    const targetEnv: NodeJS.ProcessEnv = { SHELL: shell }
    const merged = await hydrateProcessEnvFromLoginShell({
      env: targetEnv,
      shell,
      platform: 'darwin',
      cacheFilePath: cachePath,
      disableBackgroundRefresh: true,
    })
    expect(merged).toEqual([])
    expect(targetEnv.FROM_OLD_CACHE).toBeUndefined()
  })
})
