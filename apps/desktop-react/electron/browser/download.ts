/**
 * **下载落地**(B3-a;B1-a 的方案 §2.2-7 那行「下载走 Electron 缺省(B3 接)」
 * 就是这一单)。
 *
 * ## 不弹原生保存框,直接落下载目录
 *
 * Electron 的缺省是弹一张系统「存到哪」面板。这里**不要**它,三条理由:
 *
 *   ① 那张面板是**模态**的,而它会盖在一片 `WebContentsView` 上 —— 壳这一侧
 *      的遮挡判据(`NativeViewSlot` 的三条)对系统级窗口一个字都不知道,于是
 *      占位格不会换快照,而人看到的是一扇突然长出来的、壳自己不知道的窗;
 *   ② 「存到哪」是一次绝大多数人不想回答的提问。Chrome 的缺省也正是直接落
 *      下载目录,要换地方的人自己去设置里换;
 *   ③ 落点定死在下载目录,壳那一行读数才说得出一句确定的话(「已下载 x.zip」),
 *      而不是「已下载,存到你刚才选的那个地方」。
 *
 * ## 重名加序号,而不是覆盖
 *
 * `x.zip` → `x (1).zip` → `x (2).zip`(Chrome 的形)。覆盖是一次**静默的数据
 * 丢失**:同名的那一份可能是上周下的合同。序号从 1 起,上限 `MAX_DEDUPE` ——
 * 撞到一千次同名之后就不再试了,交出最后那个名字让 Electron 自己去报错,而不是
 * 在这里转一个没有出口的圈。
 *
 * ## 三态,不是进度条
 *
 * `started` / `done` / `failed`。**没有百分比** —— 壳那一行是一句文字读数
 * (禁 spinner、禁 Toast),而一条会走的进度条要一段关键帧、要一处会漂的估算,
 * 换来的信息与「它在下」逐字相同。取消与中断都折进 `failed`:对着屏幕上那一行
 * 字,「没下成」与「你自己取消了」要说的是同一句话。
 *
 * ## 零 electron import(DIP)
 *
 * `session` / `DownloadItem` / 文件系统全是结构化端口。于是「重名真的加了序号」
 * 「三态真的各发一次」「认不出 tab 的那一下不炸」在 vitest 里量得到。
 */

/** 一次下载对外说的那一句(装配点转手发成 `download` 资源事件)。 */
export interface BrowserDownloadEvent {
  readonly tabId: string
  readonly filename: string
  readonly state: 'started' | 'done' | 'failed'
  readonly path: string
}

/** `DownloadItem` 上这只文件用到的那几口。 */
export interface NativeDownloadItem {
  getFilename(): string
  setSavePath(path: string): void
  on(event: string, listener: (...args: never[]) => void): unknown
  once(event: string, listener: (...args: never[]) => void): unknown
}

/** 能挂 `will-download` 的那一口(真实现是 Electron 的 `Session`)。 */
export interface DownloadCapableSession {
  on(event: string, listener: (...args: never[]) => void): unknown
  removeListener?(event: string, listener: (...args: never[]) => void): unknown
}

/** 重名最多试这么多次。判词在文件头。 */
export const MAX_DEDUPE = 1000

/**
 * 把一个文件名拆成「主干 + 后缀」。
 *
 * **只认最后一个点,而且开头那个点不算**:`archive.tar.gz` → `archive.tar` +
 * `.gz`(与 Chrome 一致 —— 它加的是 `archive.tar (1).gz`),`.gitignore` →
 * `.gitignore` + 空(一个以点开头的名字整个是主干,不是「空主干 + .gitignore 后缀」)。
 */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/**
 * 在 `dir` 里给 `filename` 找一个还没被占的名字。
 *
 * `exists` 是注入的(测试里是一只 Set)。**答的是完整路径** —— 调用方要它去
 * `setSavePath`,再让它自己拼一次 join 就是同一件事两个产地。
 */
export function resolveDownloadPath(
  dir: string,
  filename: string,
  exists: (path: string) => boolean,
  join: (dir: string, name: string) => string,
): string {
  const safe = filename.trim() || 'download'
  const first = join(dir, safe)
  if (!exists(first)) return first
  const { stem, ext } = splitFileName(safe)
  for (let n = 1; n < MAX_DEDUPE; n += 1) {
    const candidate = join(dir, `${stem} (${n})${ext}`)
    if (!exists(candidate)) return candidate
  }
  // 一千个同名之后不再试(判词在文件头)。交出最后那个名字,让下游去报错。
  return join(dir, `${stem} (${MAX_DEDUPE})${ext}`)
}

/**
 * 门专用的落点覆盖(**只在 `ONETHING_GATE_` 前缀下生效**)。
 *
 * 真机门要断言「文件落在了下载目录里」,而它不许往用户真正的 `~/Downloads` 里
 * 扔东西(「验证不改用户状态」那条纪律)。所以这一格:`ONETHING_GATE_DOWNLOADS_DIR`
 * 在,就用它;不在,就是宿主报上来的那个目录。
 *
 * **它为什么不在 `main.ts`**:那只文件此刻有别批的脏改,而这一格本来也不属于
 * 窗口装配 —— 它是「内嵌浏览器把东西下到哪」,归这一块。判据与
 * `GATE_HEADLESS` / `GATE_OFFSCREEN` 同族:产品路径上一个字都读不到它。
 */
export const GATE_DOWNLOADS_DIR_ENV = 'ONETHING_GATE_DOWNLOADS_DIR'

export function resolveDownloadDirectory(
  hostDownloads: string,
  env: Record<string, string | undefined>,
): { dir: string; override: boolean } {
  const override = env[GATE_DOWNLOADS_DIR_ENV]?.trim()
  if (override) return { dir: override, override: true }
  return { dir: hostDownloads, override: false }
}

export interface BrowserDownloadTrackerDeps {
  /** 落哪个目录。每次下载现问 —— 设置改了不必重挂监听。 */
  readonly directory: () => string
  /** 这一发是哪一格 tab 发起的。认不出来答 `undefined`。 */
  readonly tabIdOf: (webContents: unknown) => string | undefined
  /** 路径已经被占了没有。 */
  readonly exists: (path: string) => boolean
  readonly join: (dir: string, name: string) => string
  /** 三态各发一次。装配点转手发成资源事件。 */
  readonly onEvent: (event: BrowserDownloadEvent) => void
}

/**
 * 给一个分区挂上 `will-download`。返回退订。
 *
 * **认不出 tab 的那一发照样落盘,只是不发事件**:一次下载已经在路上了,拦下来
 * 等于凭空吞掉用户的东西;而没有 tab 就没有地方画那一行读数,发一条没有地址的
 * 事件只会让订阅方去猜。
 */
export function installBrowserDownloads(
  session: DownloadCapableSession,
  deps: BrowserDownloadTrackerDeps,
): () => void {
  const onWillDownload = (_event: unknown, item: NativeDownloadItem, webContents: unknown): void => {
    const filename = item.getFilename()
    const savePath = resolveDownloadPath(deps.directory(), filename, deps.exists, deps.join)
    try {
      // 设了保存路径 = 不弹系统面板(Electron 的判据就是这一句,判词在文件头)。
      item.setSavePath(savePath)
    } catch {
      // 这一发已经自己定好了落点(极少见)。照旧往下走,读数用我们算出来的名字。
    }
    const tabId = deps.tabIdOf(webContents)
    if (!tabId) return
    const say = (state: BrowserDownloadEvent['state']): void => {
      deps.onEvent({ tabId, filename, state, path: savePath })
    }
    say('started')
    item.once('done', ((_e: unknown, state: string) => {
      // 取消 / 中断都是 `failed`(判词在文件头:对着那一行字,两者要说的是同一句话)。
      say(state === 'completed' ? 'done' : 'failed')
    }) as never)
  }

  session.on('will-download', onWillDownload as never)
  return () => {
    session.removeListener?.('will-download', onWillDownload as never)
  }
}
