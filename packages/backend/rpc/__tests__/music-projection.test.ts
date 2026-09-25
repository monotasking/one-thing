/**
 * 音乐收尾 —— **`music` 域真的退成了投影,不是双写。**
 *
 * `music-domain.test.ts` 那 21 例证的是「对外契约一个字没变」;这一组证的是另一半,
 * 而那一半在信封上看不出来:**域这一路与直接调资源面走的是同一条路**。三条判据:
 *
 *   ① 同一组参数,两条路产出**同一个结果**(信封 ↔ Outcome / ReadOutcome 一一对应);
 *   ② 一次「做」两条路各在 `<store>/audit/resource.jsonl` 上留下**同一形状的一行**
 *      —— 同一个 `toolId`、同一份效果、同一个主体、同一种结局。审计是管线发的
 *      (`AuditProjector` 只读 lifecycle,工具伪造不了),所以「审计行长得一样」就是
 *      「跑的是同一条管线」在文件上留下的证据;
 *   ③ 一次「读」两条路**一行审计都不落**(读不进管线,`core/resource/kernel.ts` 的
 *      `read` 那段注释就是这条不变量的正本)。
 *
 * 反证(施工时跑过):把 `command` 处理器改回直接调 `wiring/music/operations.js`,
 * ① 仍然绿 —— 信封是一样的 —— 而 ② 当场红:那一路一行审计都不落。契约门看不见绕过,
 * 这一组看得见。
 *
 * 它跑在**真装配**上(临时 store,`full` 档 —— 音乐只在那一档 mount),端口这一侧
 * 是假的:真的那一份要拉起 ncm-cli 的守护进程与一台 DJ agent。假法照
 * `__tests__/resource-music.test.ts`:换掉 `getCurrentBackendInstance()` 上
 * `music` 那一格,于是从 `resources.do` 到端口的每一段(内核 / 管线 / provider /
 * 那道 `assertMusicOperator` 信任门)全是真的。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-music-projection-'))
process.env.ONETHING_STORE_PATH = storeRoot

const STATUS = { active: true, intent: '安静的中文民谣', programmeLength: 5, nowPlayingTitle: '晴天' }
const NOW_PLAYING = { status: 'playing', title: '晴天 - 周杰伦', position: 41, queueLength: 5, currentIndex: 1 }
const BRIEF = {
  active: true,
  intent: '安静的中文民谣',
  lastError: undefined,
  starting: undefined,
  programmeLength: 5,
  canResume: true,
  upNext: '稻香',
  volume: 62,
}
const PROGRAMME = { entries: [{ encryptedId: 'e1', title: '稻香' }], onDeck: '晴天' }
const LYRICS = { title: '晴天 - 周杰伦', lines: [{ at: 12, text: '故事的小黄花' }] }
const RUNTIME_STATE = {
  setupStage: 'ready',
  configured: true,
  loggedIn: true,
  playerBackend: 'mpv',
  source: 'fm',
}

/** 假端口 —— 替掉的是**音乐子系统本身**那几只作用域,而不是 provider。 */
const music = vi.hoisted(() => {
  const radio = {
    radioToolOpen: vi.fn(async (intent: string) => ({ ...STATUS, intent })),
    radioToolClose: vi.fn(async () => ({ ...STATUS, active: false, programmeLength: 0 })),
    radioToolStatus: vi.fn(() => STATUS),
    requestSong: vi.fn(async () => ({ success: true, title: '晴天 周杰伦' })),
    getProgrammeSnapshot: vi.fn(() => PROGRAMME),
    applyProgrammeAction: vi.fn(() => ({ success: true })),
    getMusicLyrics: vi.fn(() => LYRICS),
  }
  const operations = {
    runMusicCommand: vi.fn(async () => ({ success: true, nowPlaying: NOW_PLAYING })),
    readRadioBrief: vi.fn(() => BRIEF),
    searchMusicSongs: vi.fn(async () => ({
      success: true,
      records: [{ title: '可惜没如果', artist: '林俊杰', playFlag: true }],
    })),
  }
  const service = {
    // 这台机器上没有播放器在跑 —— 与域那一路读到的真 watcher 缓存一致(见文件末
    // 尾那一例:同一个事实,两条路两种形状,而那正是 `getNowPlaying` 没退的理由)。
    getMusicNowPlaying: vi.fn(() => null),
    getMusicService: vi.fn(() => ({
      getState: () => RUNTIME_STATE,
      refreshEnv: async () => {},
      installTool: async () => {},
      setCredentials: async () => {},
      setPlayerBackend: async () => {},
      startLogin: async () => {},
      cancelLogin: () => {},
      checkLogin: async () => {},
      logout: async () => {},
    })),
    getActiveMusicProvider: vi.fn(() => ({ descriptor: { id: 'ncm-cli' } })),
    stopMusicPlayerKeepalive: vi.fn(),
  }
  return { radio, operations, service, onNowPlayingChanged: vi.fn(() => () => {}) }
})

vi.mock('../../current.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../current.js')>()
  const withFakeMusic = (backend: unknown): unknown =>
    backend ? new Proxy(backend as object, {
      get(target, property, receiver) {
        return property === 'music' ? music : Reflect.get(target, property, receiver)
      },
    }) : backend
  return {
    ...actual,
    getCurrentBackendInstance: () => withFakeMusic(actual.getCurrentBackendInstance()),
  }
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../../backend.js')['createOnethingBackend']>>

const PRINCIPAL = { kind: 'user', userId: 'local' } as const

/** 无会话那本账。同步写(`wiring/toolkit/audit-sink.ts`),所以不用 flush。 */
function resourceAuditRows(): Array<Record<string, unknown>> {
  const ledger = path.join(storeRoot, 'audit', 'resource.jsonl')
  if (!fs.existsSync(ledger)) return []
  return fs
    .readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** 一行审计的**可比较**部分:`callId` 与 `at` 逐次不同(它们正是「两次不同的调用」)。 */
function comparableAudit(row: Record<string, unknown> | undefined): Record<string, unknown> {
  const data = { ...row }
  delete data.callId
  delete data.at
  return data
}

describe('music 域 = 资源投影(音乐收尾)', () => {
  let backend: Backend
  let restoreTrust: (() => void) | undefined

  beforeAll(async () => {
    const { createOnethingBackend } = await import('../../backend.js')
    backend = await createOnethingBackend({
      host: {
        storePath: {},
        sandbox: {},
        auth: null,
        logging: null,
        shell: null,
        voice: null,
        terminal: null,
        skillsEnvironment: null,
        todoPlan: null,
        scratchpad: null,
        plugins: null,
        gateway: null,
        settings: null,
        evals: null,
        mcp: null,
        localTrust: null,
        speechOutput: null,
        dialog: null,
      },
      // 音乐只在 `full` 档 mount(`wiring/resource/index.ts` 的 `tier` 那一格)。
      toolRegistry: 'full',
      sender: new NoopSender() as never,
    })
    // 默认那只 dispatch context 是桌面那条(没有 ownerUid),所以主体靠「本机可信」
    // 这一条铸(`rpc/principal.ts` 第一条)。
    const { configureHostLocalTrust } = await import('../../server/host-trust.js')
    restoreTrust = configureHostLocalTrust({ origin: 'desktop-embedded' })

    // 电台总开关:`openRadio` 的前置判据读它,而它默认是关的。
    const settings = await import('../../stores/settings.js')
    const current = settings.getSettings()
    settings.saveSettings({
      ...current,
      music: { ...current.music, enabled: true, provider: 'ncm-cli' },
    } as never)
  }, 180_000)

  afterAll(async () => {
    restoreTrust?.()
    await backend?.dispose()
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
    fs.rmSync(storeRoot, { recursive: true, force: true })
  })

  const dispatch = async (method: string, payload: unknown = {}) => {
    const { dispatchRpc } = await import('../registry.js')
    return dispatchRpc({ domain: 'music', method, payload })
  }

  // ── 六条读面:两条路同值,而且**一行审计都不落** ──────────────────────────
  const READS: Array<[string, unknown, string, string, Record<string, unknown>, (value: unknown) => unknown]> = [
    ['getState', {}, 'music:provider', 'state', {}, value => ({ success: true, state: value })],
    ['getRadio', {}, 'music:radio', 'brief', {}, value => value],
    ['getLyrics', {}, 'music:player', 'lyrics', {}, value => value],
    ['getProgramme', {}, 'music:radio', 'programme', {}, value => ({ success: true, ...(value as object) })],
    ['listProviders', {}, 'music:provider', 'providers', {}, value => ({ success: true, ...(value as object) })],
    [
      'search',
      { query: ' 林俊杰 ' },
      'music:provider',
      'search',
      { query: '林俊杰' },
      value => ({ success: true, ...(value as object) }),
    ],
  ]

  for (const [method, payload, ref, name, query, project] of READS) {
    it(`${method}:域这一路 = 直调 read,而且两条路都不落审计`, async () => {
      const before = resourceAuditRows().length

      const viaDomain = await dispatch(method, payload)
      const viaKernel = await backend.resources.read(ref, name, query, { principal: PRINCIPAL })

      expect(viaKernel.kind).toBe('ok')
      const value = viaKernel.kind === 'ok' ? viaKernel.value : undefined
      expect(viaDomain).toEqual({ ok: true, data: project(value) })
      // ③ 读是查询,它不产生事实。
      expect(resourceAuditRows().length).toBe(before)
    })
  }

  // ── 五条写面:两条路同结果、各留一行同形的审计 ────────────────────────────
  const OPS: Array<[string, Record<string, unknown>, string, string, Record<string, unknown>, unknown]> = [
    ['openRadio', { intent: ' 深夜 ', clearProgramme: false }, 'music:radio', 'open', { intent: '深夜' }, { success: true }],
    ['command', { command: 'pause' }, 'music:player', 'pause', {}, { success: true, nowPlaying: NOW_PLAYING }],
    [
      'programmeAction',
      { action: { kind: 'remove', encryptedId: 'e1' } },
      'music:radio',
      'programmeAction',
      { action: { kind: 'remove', encryptedId: 'e1' } },
      { success: true },
    ],
    ['setProvider', { providerId: 'ncm-cli' }, 'music:provider', 'setProvider', { providerId: 'ncm-cli' }, { success: true }],
    ['requestSong', { query: '晴天' }, 'music:radio', 'request', { song: '晴天' }, { success: true, title: '晴天 周杰伦' }],
  ]

  for (const [method, payload, ref, op, params, expected] of OPS) {
    it(`${method}:域这一路与直调资源面同结果、同一条 tool/audit`, async () => {
      const before = resourceAuditRows().length
      const viaDomain = await dispatch(method, payload)
      const afterDomain = resourceAuditRows()

      const viaKernel = await backend.resources.do(ref, op, params, { principal: PRINCIPAL })
      const afterKernel = resourceAuditRows()

      // ① 同结果。
      expect(viaDomain).toEqual({ ok: true, data: expected })
      expect(viaKernel.kind).toBe('ok')

      // ② 各留一行,而且两行同形。
      expect(afterDomain.length - before).toBe(1)
      expect(afterKernel.length - afterDomain.length).toBe(1)
      expect(comparableAudit(afterDomain[afterDomain.length - 1]))
        .toEqual(comparableAudit(afterKernel[afterKernel.length - 1]))
      expect(comparableAudit(afterDomain[afterDomain.length - 1])).toMatchObject({
        toolId: 'music',
        outcome: 'ok',
        // 本机那个人自己按的按钮:效果按主体分档之后是空的(`setProvider` 那一条
        // 在自述里的上界是 `capability_change`,这里被分档降成 `[]`)。
        effects: [],
        effectCount: 0,
        principal: { kind: 'user', userId: 'local' },
      })
    })
  }

  /**
   * `setup` 单独一例:回执带着**整份状态**,而那一格是从 `Result.details` 上抬的
   * (`foldOutcomeToDetailedEnvelope`)。顺带钉住那条搬进 provider 的产品逻辑:
   * 停在 `ready` + `mpv` 时**不**去停保活播放器。
   */
  it('setup:回执带整份状态,而且 ready+mpv 时不动保活播放器', async () => {
    music.service.stopMusicPlayerKeepalive.mockClear()

    const viaDomain = await dispatch('setup', { action: 'check-env' })
    expect(viaDomain).toEqual({ ok: true, data: { success: true, state: RUNTIME_STATE } })
    expect(music.service.stopMusicPlayerKeepalive).not.toHaveBeenCalled()
  })

  /**
   * `seek` / `volume` 的数值参数:「缺」与「给错」是同一句话,而那句话的产地是
   * `wiring/music/operations.ts` 的 `argsWithValue` —— 退成投影之后它没有改口。
   */
  it('seek / volume:缺一个数与给一个非数说的是同一句话;给对了就原样递给端口', async () => {
    for (const command of ['seek', 'volume'] as const) {
      expect(await dispatch('command', { command })).toEqual({
        ok: true,
        data: { success: false, error: `${command} 需要一个数值参数` },
      })
      expect(await dispatch('command', { command, value: Number.NaN })).toEqual({
        ok: true,
        data: { success: false, error: `${command} 需要一个数值参数` },
      })
    }

    music.operations.runMusicCommand.mockClear()
    expect(await dispatch('command', { command: 'seek', value: 42 })).toEqual({
      ok: true,
      data: { success: true, nowPlaying: NOW_PLAYING },
    })
    expect(music.operations.runMusicCommand).toHaveBeenCalledWith({ command: 'seek', value: 42 })
  })

  /**
   * 换音乐后端**按主体分档**:人自己按的那一次不弹卡(再问一遍是噪音),模型 /
   * 插件 / 脚本要动它就顶格问 —— 而且 `capability_change` 在效果表里是
   * never-grantable,授权不了「以后都行」。
   */
  it('setProvider:模型要换后端会停在一张真权限卡上,本机那个人不会', async () => {
    const store = await import('../../store.js')
    const { Permission } = await import('../../wiring/permission/index.js')
    const sessionId = store.createSession(`music-projection-${Date.now()}`, 'Music').id

    // 人这一侧:一张卡都不出,当场就完。
    const byUser = await backend.resources.do(
      'music:provider',
      'setProvider',
      { providerId: 'ncm-cli' },
      { principal: PRINCIPAL, sessionId },
    )
    expect(byUser.kind).toBe('ok')
    expect(Permission.getPendingPrompts(sessionId)).toHaveLength(0)

    // 模型这一侧:停在卡上,答了才走。
    const byAgent = backend.resources.do(
      'music:provider',
      'setProvider',
      { providerId: 'ncm-cli' },
      { principal: { kind: 'agent', agentId: 'dj' }, sessionId },
    )
    await vi.waitFor(() => expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1))
    const card = Permission.getPendingPrompts(sessionId)[0]
    expect(card.title).toBe('Switch the music backend to ncm-cli')
    Permission.respond({ sessionId, permissionId: card.id, response: 'once' })
    expect((await byAgent).kind).toBe('ok')
  })

  /**
   * `getNowPlaying` / `djSpeakDone` **没有**退成投影(理由在 `rpc/domains/music.ts`
   * 的文件头)。这一例把那件事钉住:它们照旧不经内核 —— 一行审计都不落,而且
   * `getNowPlaying` 仍然答得出 `null`(那正是没退的原因)。
   */
  it('getNowPlaying:没退成投影,所以它照旧不经内核,而且答得出 `null`', async () => {
    const before = resourceAuditRows().length

    // 它读的是 watcher 的缓存(`wiring/music/service.js` 的进程槽访问器,走的是
    // `getCurrentBackend` 而不是被这组用例换掉的那一口)—— 这台机器上没有播放器
    // 在跑,所以答案是 `null`。**那正是它没退成投影的理由**:资源面那条
    // `nowPlaying` 读法刻意把 `null` 折成一份「停着」的读数,退过去就再也答不出
    // 这个值了,而它写在契约上(`MusicNowPlaying | null`)。
    const answered = await dispatch('getNowPlaying')
    expect(answered).toEqual({ ok: true, data: null })
    expect(resourceAuditRows().length).toBe(before)

    // 同一时刻,资源面那条读法答的是一份「停着」的读数 —— 两条路对同一个事实说的
    // 不是同一句话,而统一它是一次要人拍的行为变化(留账)。
    const read = await backend.resources.read('music:player', 'nowPlaying', {}, { principal: PRINCIPAL })
    expect(read.kind === 'ok' ? read.value : undefined).toMatchObject({ playing: false, status: 'stopped' })
  })
})
