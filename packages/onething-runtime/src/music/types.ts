/**
 * Music setup types.
 *
 * Host-free: nothing here imports Electron or node child_process. The driver
 * receives its process spawning capability through injection so the same code
 * can run under a headless host or a test double.
 */

/** The radio source the model reaches for by default. */
export type OnethingMusicRadioSource = 'fm' | 'daily'

/**
 * Which player ncm-cli drives.
 *
 * - `mpv`: ncm-cli plays the audio itself (legacy in-process sessions). `state`
 *   answers, so the model can see position and know when a song ends.
 * - `orpheus`: hands tracks to the local 网易云音乐 App, which owns playback and
 *   advances its own queue. `state` is rejected ("云音乐模式下不支持 state 命令"),
 *   so there is no progress to read — macOS only.
 */
export type OnethingMusicPlayerBackend = 'mpv' | 'orpheus'

export type OnethingMusicSetupStage = 'env' | 'credentials' | 'login' | 'ready'

/**
 * 登录这一步走到哪儿了。
 *
 * **只有五种真状态,没有「已扫码待确认」**(2026-09-18 立;正本
 * `apps/desktop-react/docs/music-panel-2026-09.md` §6.1 最后一行):`login --check`
 * 只答成没成,这台机器拿不到「扫了但还没在手机上按确认」那一格 —— 编一个出来,
 * 界面就会对着一个永远不会到达的中间态画进度。
 *
 *  · `idle`     没在登录(还没开始 / 取消了 / 退出登录之后);
 *  · `starting` 已经去叫 CLI 了,地址还没回来;
 *  · `waiting`  地址拿到了(`url`),等人用手机扫或者在浏览器里登;
 *  · `ok`       `login --check` 答成了;
 *  · `failed`   启动登录失败,`message` 是后端自己那句话;
 *  · `quota`    额度用完了 —— 与 `failed` 分开一格,因为那**不是这台机器的问题**
 *               (网易云的日配额),界面要照后端原文说,不该劝人重试。
 */
export type OnethingMusicLoginStatus = 'idle' | 'starting' | 'waiting' | 'ok' | 'failed' | 'quota'

export interface OnethingMusicLoginState {
  status: OnethingMusicLoginStatus
  /**
   * 登录地址 —— `login --background --output json` 交出来的 `qrCodeUrl`
   * (拿不到就退而用 `clickableUrl`)。**只有一格**:这两条是同一次登录的同一个
   * 地址在两种终端里的两种印法,壳拿它同时做三件事(画二维码 / 在浏览器里打开 /
   * 复制)。真有一天两者不是同一个地址了,再开第二格,而且那时会有一个真理由。
   *
   * `waiting` 时必有;其余状态下没有意义。
   */
  url?: string
  /** 失败 / 超额时后端自己那句话。**这里不发明文案**。 */
  message?: string
}

export interface OnethingMusicToolStatus {
  installed: boolean
  version?: string
}

export interface OnethingMusicEnvStatus {
  /** Keyed by the provider descriptor's tool ids (ncm: 'ncm-cli', 'mpv'). */
  tools: Record<string, OnethingMusicToolStatus>
  npmAvailable: boolean
  brewAvailable: boolean
}

/**
 * Setup state — no playback.
 *
 * Playback used to live here (player state, programme queue, radioActive) back
 * when the app conducted the radio itself. The model drives ncm-cli through
 * bash now, so the current song is whatever `ncm-cli queue` says; mirroring it
 * here would only be a second, staler copy of a truth we do not own.
 */
export interface OnethingMusicRuntimeState {
  setupStage: OnethingMusicSetupStage
  env?: OnethingMusicEnvStatus
  configured: boolean
  loggedIn: boolean
  /** Which player ncm-cli is configured to drive. */
  playerBackend: OnethingMusicPlayerBackend
  source: OnethingMusicRadioSource
  /**
   * 登录那一步的现状(2026-09-18 补的那一格)。
   *
   * 从前登录地址只随 `login-output` 那条旧推送发出去一次,而那条推送骑在
   * `MUSIC_EVENT` 这个宿主广播上 —— React 壳的 `voice` 端口是 `null`,它一个字都
   * 收不到,于是「登录」那一步在壳上是一块永远空着的地。地址记进状态之后,它跟着
   * `state` 这条读法走资源路,每一台宿主拿到的是同一份。
   */
  login: OnethingMusicLoginState
  lastError?: string
}

export type OnethingMusicEvent =
  | { type: 'state'; state: OnethingMusicRuntimeState }
  | { type: 'login-output'; chunk: string }
  | { type: 'install-output'; tool: string; chunk: string }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }

// ============================================================================
// Process abstraction (injected by the host)
// ============================================================================

export interface OnethingMusicProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface OnethingMusicProcessRunOptions {
  command: string
  args: string[]
  /** Written to the child's stdin, then closed. Used to keep secrets off argv. */
  stdin?: string
  timeoutMs?: number
  env?: Record<string, string | undefined>
}

export interface OnethingMusicProcessStreamOptions extends OnethingMusicProcessRunOptions {
  onStdout?(chunk: string): void
  onStderr?(chunk: string): void
}

export interface OnethingMusicProcessHandle {
  /** Resolves when the child exits. */
  done: Promise<OnethingMusicProcessResult>
  kill(): void
}

export interface OnethingMusicProcessRunner {
  run(options: OnethingMusicProcessRunOptions): Promise<OnethingMusicProcessResult>
  spawn(options: OnethingMusicProcessStreamOptions): OnethingMusicProcessHandle
}

// ============================================================================
// Backend contract
// ============================================================================

/**
 * The music setup backend — what the settings wizard needs, and nothing else.
 *
 * Playback (search/play/queue/state/volume…) deliberately has no place here:
 * the model runs those ncm-cli commands itself through bash, so a typed
 * wrapper would only be a second, always-behind copy of a CLI whose command
 * tree is server-driven and grows without us.
 */
export interface OnethingMusicBackend {
  checkEnv(): Promise<OnethingMusicEnvStatus>
  /** `tool` is a descriptor tool id; unknown ids reject. */
  installTool(tool: string, onOutput?: (chunk: string) => void): Promise<void>
  setCredentials(appId: string, privateKey: string): Promise<void>
  isConfigured(): Promise<boolean>
  getPlayer(): Promise<OnethingMusicPlayerBackend>
  setPlayer(player: OnethingMusicPlayerBackend): Promise<void>

  /** Starts an interactive login, streaming the QR payload out. */
  startLogin(onOutput: (chunk: string) => void): Promise<void>
  cancelLogin(): void
  checkLogin(): Promise<boolean>
  logout(): Promise<void>
}

/**
 * Thrown when ncm-cli reports the daily open-platform quota is exhausted.
 *
 * Not counted anywhere any more: the model spends the quota by running ncm-cli
 * through bash, so the app cannot see those calls. Tracking a number we no
 * longer observe would just be a stale one on screen. The skill tells the model
 * to relay "请求总量超限" to the user verbatim when it hits it.
 */
export class OnethingMusicQuotaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OnethingMusicQuotaError'
  }
}

