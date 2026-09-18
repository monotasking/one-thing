/**
 * Music setup: environment probing, credentials, login, player choice.
 *
 * Setup only — deliberately no playback. Playback is the model's job now: it
 * drives `ncm-cli` through bash, guided by the `netease-music-cli` skill. This
 * used to be a "radio conductor" that owned a programme queue, polled `state`
 * to detect the end of a song, and skipped dead tracks. All of it is gone,
 * because wrapping ncm-cli turned out to cost far more than it bought — every
 * bug we shipped lived in the gap between the wrapper and the real CLI, while
 * the wrapper exposed 4 of the CLI's 71 commands.
 *
 * What cannot move to the model is exactly what is left here: setup needs the
 * privateKey, and a privateKey must never pass through a chat message (it would
 * be written into the session history forever) nor through argv (where `ps`
 * shows it to every process on the machine). So credentials stay behind the
 * settings UI, and this service is what that UI talks to.
 */

import type { MusicProviderToolSpec } from './providers/types.js'
import { OnethingMusicQuotaError } from './types.js'
import type {
  OnethingMusicBackend,
  OnethingMusicEnvStatus,
  OnethingMusicEvent,
  OnethingMusicLoginState,
  OnethingMusicPlayerBackend,
  OnethingMusicRadioSource,
  OnethingMusicRuntimeState,
  OnethingMusicSetupStage,
} from './types.js'

export interface MusicSetupServiceOptions {
  backend: OnethingMusicBackend
  emit(event: OnethingMusicEvent): void
  getSource(): OnethingMusicRadioSource
  /**
   * The active provider's tool prerequisites (descriptor.tools). Absent =
   * the founding ncm pair, so existing hosts/tests keep today's gates.
   */
  tools?: MusicProviderToolSpec[]
  now?(): number
  logger?: { warn(message: string, ...args: unknown[]): void }
}

const DEFAULT_TOOLS: MusicProviderToolSpec[] = [
  { id: 'ncm-cli', label: 'ncm-cli', install: { npm: ['install', '-g', '@music163/ncm-cli'] } },
  { id: 'mpv', label: 'mpv', install: { brew: ['install', 'mpv'] }, requiredWhenPlayerBackend: 'mpv' },
]

function createInitialState(source: OnethingMusicRadioSource): OnethingMusicRuntimeState {
  return {
    setupStage: 'env',
    configured: false,
    loggedIn: false,
    playerBackend: 'mpv',
    source,
    login: { status: 'idle' },
  }
}

/**
 * 从 `startLogin` 交出来的那一块 stdout 里读出登录地址。
 *
 * 驱动把 ncm-cli 的信封**重新序列化**过一次再交出来(它自己文件头上写着理由:
 * 原始 stdout 里夹着非 JSON 的杂行),所以这里认的是一行 JSON。认不出来就答
 * `undefined` —— 一块读不懂的输出不是一个地址,不许猜。
 *
 * 取 `qrCodeUrl` 优先:那是给「编码成一张码」用的那一份,结构上必须是一条能被
 * 扫的地址;`clickableUrl` 是同一条地址在终端里的可点印法,只在前者缺席时退用。
 */
export function parseMusicLoginUrl(chunk: string): string | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(chunk)
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as { qrCodeUrl?: unknown; clickableUrl?: unknown }
  for (const value of [record.qrCodeUrl, record.clickableUrl]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export class MusicSetupService {
  private state: OnethingMusicRuntimeState
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly options: MusicSetupServiceOptions) {
    this.state = createInitialState(options.getSource())
    const backend = options.backend
    this.options = { ...options, backend: this.guarded(backend) }
    this.cancelBackendLogin = () => backend.cancelLogin()
  }

  private readonly cancelBackendLogin: () => void

  /**
   * 关机闸 + 未决登记,**逐个方法显式包**(工单 4 C8)。
   *
   * 从前这里是一只 `Proxy`,`get` trap 上「凡是函数就包、凡是返回 thenable 就
   * 登记」。代价有三:契约变成运行时猜的(后端多一个方法就自动多一道闸,没人
   * 决定过);读代码的人在这个文件里看不出哪几件受闸;而 `typeof value ===
   * 'function'` 与 `result.then` 这两条鸭子判据,对一个只是恰好返回 thenable 的
   * 属性会误伤。列出来是十行,换来的是「受闸的就是这十件,一件不多」。
   */
  private guarded(backend: OnethingMusicBackend): OnethingMusicBackend {
    const guard = <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> => {
        this.assertActive()
        return this.track(run.apply(backend, args))
      }
    return {
      checkEnv: guard(backend.checkEnv),
      installTool: guard(backend.installTool),
      setCredentials: guard(backend.setCredentials),
      isConfigured: guard(backend.isConfigured),
      getPlayer: guard(backend.getPlayer),
      setPlayer: guard(backend.setPlayer),
      startLogin: guard(backend.startLogin),
      checkLogin: guard(backend.checkLogin),
      logout: guard(backend.logout),
      // 唯一同步的一件:照样过闸,但没有可登记的未决工作。
      cancelLogin: () => { this.assertActive(); backend.cancelLogin() },
    }
  }

  private assertActive(): void { if (this.closed) throw new Error('Music setup service is shutting down') }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work))
    return work
  }

  getState(): OnethingMusicRuntimeState {
    this.assertActive()
    return this.state
  }

  private patch(patch: Partial<OnethingMusicRuntimeState>): void {
    if (this.closed) return
    this.state = { ...this.state, ...patch }
    this.options.emit({ type: 'state', state: this.state })
  }

  private requiredTools(player: OnethingMusicPlayerBackend): MusicProviderToolSpec[] {
    // A tool can be conditional on the chosen player backend (ncm: mpv is
    // irrelevant under orpheus — demanding it would strand a working setup
    // on the "install" step).
    return (this.options.tools ?? DEFAULT_TOOLS).filter(
      tool => !tool.requiredWhenPlayerBackend || tool.requiredWhenPlayerBackend === player,
    )
  }

  private resolveSetupStage(
    env: OnethingMusicRuntimeState['env'],
    configured: boolean,
    loggedIn: boolean,
    player: OnethingMusicPlayerBackend,
  ): OnethingMusicSetupStage {
    if (this.requiredTools(player).some(tool => !env?.tools[tool.id]?.installed)) return 'env'
    if (!configured) return 'credentials'
    if (!loggedIn) return 'login'
    return 'ready'
  }

  private refreshSetupStage(): void {
    this.patch({
      setupStage: this.resolveSetupStage(
        this.state.env,
        this.state.configured,
        this.state.loggedIn,
        this.state.playerBackend,
      ),
    })
  }

  /**
   * 一次 `login --check` 之后,登录那一格该是什么。
   *
   * 成了就是 `ok`。**没成不等于失败**:壳在 `waiting` 期间每 2.5s 问一次,那几声
   * 「还没」正是等待本身 —— 把它记成 `idle` 会让地址与二维码在人扫码的当口消失。
   * 所以只有本来就不在登录中的时候才回落到 `idle`。
   */
  private loginAfterCheck(loggedIn: boolean): OnethingMusicLoginState {
    if (loggedIn) return { status: 'ok' }
    const current = this.state.login
    return current.status === 'starting' || current.status === 'waiting' ? current : { status: 'idle' }
  }

  /** 失败 / 超额各自那一格。额度是网易云的事,不是这台机器的,所以分开一格。 */
  private loginFailure(error: unknown, fallback: string): OnethingMusicLoginState {
    const message = error instanceof Error && error.message ? error.message : fallback
    return { status: error instanceof OnethingMusicQuotaError ? 'quota' : 'failed', message }
  }

  private handleError(error: unknown, fallback: string): Error {
    const message = error instanceof Error && error.message ? error.message : fallback
    this.patch({ lastError: message })
    return new Error(message)
  }

  async refreshEnv(): Promise<OnethingMusicEnvStatus | undefined> {
    this.assertActive()
    return this.track((async () => {
    const env = await this.options.backend.checkEnv()

    // With the CLI itself missing there is nothing to probe further.
    const cliTool = (this.options.tools ?? DEFAULT_TOOLS)[0]
    if (cliTool && !env.tools[cliTool.id]?.installed) {
      this.patch({ env, setupStage: 'env' })
      return env
    }

    let loggedIn: boolean
    let configured: boolean
    let playerBackend: OnethingMusicPlayerBackend
    try {
      // Order matters for latency, not correctness. `login --check` costs ~0.25s
      // and a positive answer already proves credentials exist, whereas
      // `config list` costs ~10s (ncm-cli syncs its server manifest first). So
      // ask the cheap question, and only pay for `config list` when the answer
      // is no and we have to tell "no credentials" apart from "not logged in"
      // to point the wizard at the right step.
      loggedIn = await this.options.backend.checkLogin()
      configured = loggedIn || (await this.options.backend.isConfigured())
      playerBackend = await this.options.backend.getPlayer()
    } catch (error) {
      // A probe blew up (daily quota spent, ncm-cli hiccup). That tells us
      // nothing about the setup, so say what went wrong and keep the last
      // known answer. Reporting the failure as `configured: false` would walk
      // the user back to the credentials step and have them re-enter a
      // privateKey that was never the problem — and spend more quota trying.
      this.patch({ env, lastError: error instanceof Error ? error.message : '音乐环境探测失败' })
      this.options.logger?.warn('[music] environment probe failed; keeping last known setup state', error)
      return env
    }

    this.patch({
      env,
      configured,
      loggedIn,
      playerBackend,
      lastError: undefined,
      login: this.loginAfterCheck(loggedIn),
      setupStage: this.resolveSetupStage(env, configured, loggedIn, playerBackend),
    })
    return env

    })())
  }

  async ensureSetupStage(): Promise<OnethingMusicSetupStage> {
    this.assertActive()
    return this.track((async () => {
    if (!this.state.env) await this.refreshEnv()
    return this.state.setupStage

    })())
  }

  /** Switching player is a setup action: it can change the stage (mpv gate). */
  async setPlayerBackend(player: OnethingMusicPlayerBackend): Promise<void> {
    this.assertActive()
    return this.track((async () => {
    try {
      await this.options.backend.setPlayer(player)
    } catch (error) {
      throw this.handleError(error, '切换播放器失败')
    }
    this.patch({ playerBackend: player })
    this.refreshSetupStage()

    })())
  }

  async installTool(tool: string): Promise<void> {
    this.assertActive()
    return this.track((async () => {
    try {
      await this.options.backend.installTool(tool, chunk => {
        if (!this.closed) this.options.emit({ type: 'install-output', tool, chunk })
      })
    } catch (error) {
      throw this.handleError(error, `${tool} 安装失败`)
    }
    await this.refreshEnv()

    })())
  }

  async setCredentials(appId: string, privateKey: string): Promise<void> {
    this.assertActive()
    return this.track((async () => {
    try {
      await this.options.backend.setCredentials(appId, privateKey)
    } catch (error) {
      throw this.handleError(error, '凭证写入失败')
    }
    this.patch({ configured: true })
    this.refreshSetupStage()

    })())
  }

  /**
   * 开一次登录。
   *
   * 地址在**这一发之内**就到:`login --background` 打印一个信封就退出,把等人扫码
   * 那一段留给它自己 detach 出去的轮询器。所以 `startLogin` 返回时,`login` 那一格
   * 已经是 `waiting` + `url` —— 调用方不必再问一次。
   *
   * 地址一个字都不进日志:它是一次登录会话的凭据,谁拿到谁就能把这个账号登上。
   */
  async startLogin(): Promise<void> {
    this.assertActive()
    return this.track((async () => {
    this.patch({ login: { status: 'starting' } })
    try {
      await this.options.backend.startLogin(chunk => {
        if (this.closed) return
        // 旧推送原样留着(它是这条路的原始输出口),新的那一格是从同一块输出里读的。
        this.options.emit({ type: 'login-output', chunk })
        const url = parseMusicLoginUrl(chunk)
        if (url) this.patch({ login: { status: 'waiting', url } })
      })
    } catch (error) {
      this.patch({ login: this.loginFailure(error, '登录启动失败') })
      throw this.handleError(error, '登录启动失败')
    }
    // 跑成了却没有地址 = 启动了一场没人扫得了的登录。**说出来**,别停在转圈上
    // (那正是这一格补上之前登录那一步的样子:一块永远空着的地)。
    if (this.state.login.status === 'starting') {
      this.patch({ login: { status: 'failed', message: '没有拿到登录地址' } })
    }

    })())
  }

  cancelLogin(): void {
    this.options.backend.cancelLogin()
    this.patch({ login: { status: 'idle' } })
  }

  async checkLogin(): Promise<boolean> {
    this.assertActive()
    return this.track((async () => {
    let loggedIn: boolean
    try {
      loggedIn = await this.options.backend.checkLogin()
    } catch (error) {
      // 驱动只把额度这一种错抛上来(别的都折成「没登上」)。它不是「没登上」,
      // 所以照后端原文记一格,再原样抛给调用方。
      this.patch({ login: this.loginFailure(error, '登录检查失败') })
      throw this.handleError(error, '登录检查失败')
    }
    this.patch({ loggedIn, login: this.loginAfterCheck(loggedIn) })
    this.refreshSetupStage()
    return loggedIn

    })())
  }

  async logout(): Promise<void> {
    this.assertActive()
    return this.track((async () => {
    try {
      await this.options.backend.logout()
    } catch (error) {
      throw this.handleError(error, '退出登录失败')
    }
    this.patch({ loggedIn: false, login: { status: 'idle' } })
    this.refreshSetupStage()

    })())
  }

  setSource(source: OnethingMusicRadioSource): void {
    this.assertActive()
    this.patch({ source })
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.cancelBackendLogin()
  }

  async drain(): Promise<void> {
    this.dispose()
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}
