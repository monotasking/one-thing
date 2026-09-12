import { controlByteOf } from './key-courtesy'
import type { TerminalPort } from '../../data/terminal-port'
import type { TerminalFindDirection, TerminalScreen } from './screen'

/**
 * **一格终端的实例**(T1,方案 §2.1-4;状态表 §3.1)。
 *
 * 一句话:**它是那条协议的全部**。屏幕(xterm)只管画,端口只管往返,这只类
 * 管的是中间那些必须答对的问题 —— 回放从哪一条接上、哪些帧是旧的、代次换了
 * 之后旧回执还算不算数、什么时候该说「我收到了」、屏幕隐藏着的时候要不要
 * 报尺寸、进程死了之后这块屏留不留。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期(组件那两张表在 `TerminalLeaf.tsx` 的组件头上)
 * ══════════════════════════════════════════════════════════════════════════
 *  · 建   —— `new TerminalSession(id, …)`:造屏幕、订两条推送、把用户敲的键
 *            接到 `write` 上。**产地是注册表**(`registry.ts`),不是组件 ——
 *            一格终端的寿命是「那格 PTY」,不是「那次挂载」;
 *  · 首载 —— `attach()`:一次往返换回三样东西(回放、`lastSeq`、代次)。
 *            `truncated` 时先写一个全重置(`\x1bc`)—— ring 绕过一圈的回放可能
 *            从一条转义序列的中间开始,不重置就会把后面的字全画成乱色;
 *  · 换宿主 —— **一格都不动**。组件挂载只 `appendChild(screen.element)`,卸载
 *            **不销毁**(旧壳 D6 判例:拖到别的叶不丢屏)。那块 DOM 从一棵树
 *            搬到另一棵树,xterm 的缓冲、滚动位置、选区全在;
 *  · 卸载 —— `dispose()`:销毁屏幕 + 退两条订阅。**不杀 PTY**。杀是
 *            `kill()`,那是「关标签」这个动作的语义,不是「不看了」的;
 *  · 重启后 —— 账上残留的 id `attach` 不上 → `dead`,cwd 从本地小账本取,
 *            画「已结束」+「在同一目录再开一个」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ② UI 生命状态(五档,§3.1 那张表逐格)
 * ══════════════════════════════════════════════════════════════════════════
 *  · `attaching` 一次 attach 往返在飞。屏幕已经在,只是还没接上;
 *  · `live`      在写、在回执、`terminal:data` 在到;
 *  · `detached`  某一发往返报了不成功而进程还在 —— 这份订阅不再可信,屏幕停在
 *                最后一帧,檐上「已断开,点击重连」。**它不是「没网」**:
 *                真正的传输面断线由 `platform/connection` 那一格答;
 *  · `exited`    `terminal:exit` 到了。屏幕保留(人要看最后那几行),输入禁用;
 *  · `dead`      attach 不上。账上有 id,机器上没有那格 PTY。
 *
 * 与这五档**正交**的还有一格:查找行(T2)。它不是一种生死,所以不进这张表 ——
 * 自己的四档写在 `TerminalFindState` 上,理由(为什么它住在实例上而不是组件里)
 * 也在那儿。
 *
 * 超量:一次 `seq 1 20000` 是两万条短帧。这一层**不攒不丢**(攒 = 延迟,丢 =
 * 撒谎),只按 `seq` 去重后原样写进 xterm —— 攒批是 core 那边 16ms flush 的事
 * (`service.wiring.ts`),重画节流是 xterm 自己的事。真机读数进 `gate:terminal` ⑤。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三件容易写错的事,各一段判词
 * ══════════════════════════════════════════════════════════════════════════
 * **去重按 `seq`,不按到达顺序。** attach 的回放与推送之间有一段重叠窗口:
 * 服务端先 flush 再发快照,但快照送回渲染层的这一路上,新的 `terminal:data`
 * 可能已经到了。`seq <= lastSeq` 一律丢 —— 这条判据同时兼了「回放里已经有的
 * 别写第二遍」与「重连之后旧帧别倒着插进来」两件事。
 *
 * **回执按字节、带代次,而且回放那一段不记账。** 契约原话:"Replayed chunks
 * must NOT be acked by the caller"。字节口径两边都是 JS 字符串长度(UTF-16
 * 码元)—— 换成 utf8 字节数会在中文输出上把水位账记漂。代次在写进去的那一刻
 * 就**闭包捕获**:一次 re-attach 之后,上一代还没画完的那几段回调不许拿新代次
 * 去回执(服务端会丢掉旧代次的回执,而我们这边会把已经清零的账本再减一次)。
 *
 * **阈值 16KB。** 太小 = 每一小段输出配一发 RPC(一次 `seq 1 20000` 能打出上万
 * 发);太大 = 越过服务端 128KB 的高水位,它暂停读 PTY、挂 5 秒停滞表、然后
 * **自动 detach**(`service.wiring.ts` 的 `ackStallMs`)。16KB 在两者中间:
 * 高水位之前能回执八次,而一屏输出通常一发都不到。
 */

/** 攒够这么多字节(UTF-16 码元)回执一次。判词见文件头。 */
export const ACK_THRESHOLD_UNITS = 16 * 1024

export type TerminalState = 'attaching' | 'live' | 'detached' | 'exited' | 'dead'

/**
 * **终端内查找的那一格状态**(T2)。
 *
 * ── 它为什么住在实例上,而不是叶那只组件的 `useState` ────────────────────
 * 判据与「屏幕住在注册表里」逐字同一条:**这件事的寿命是那格 PTY,不是这次
 * 挂载**。查找的高亮、选区、当前命中全在 xterm 那块缓冲里(DOM 搬家不丢),
 * 把「开着没有 / 找的是什么词」放进组件 state 会让它们在一次换宿主(撕浮窗、
 * 铺满、拖到别的叶)之后当场分叉:屏幕上还亮着十七处高亮,查找行却没了。
 *
 * 四档(状态表,与叶那三张表同页):
 *  · 关        `open=false`,没有高亮;
 *  · 开无输入  `open=true, query=''`,读数整格不画(禁令区:没内容就别占地方);
 *  · 开有命中  `count>0`,读数「index+1/count」;
 *  · 开零命中  `count===0 且 query 非空`,读数「0」—— **不弹**任何东西,
 *              一个数字就是全部答案(零 Toast)。
 */
export interface TerminalFindState {
  open: boolean
  query: string
  /** 当前命中的序号(从 0 起,`-1` = 没有)。 */
  index: number
  count: number
}

const FIND_CLOSED: TerminalFindState = { open: false, query: '', index: -1, count: 0 }

export interface TerminalSnapshot {
  id: string
  state: TerminalState
  /** `exited` 那一档的退出码。`null` = 被信号杀掉。 */
  exitCode?: number | null
  /** 活标题:OSC 标题 → cwd 末段 → shell 名(三档由 `titleOf` 合,见下)。 */
  title: string
  /** 这格终端的工作目录(attach 交回来的 `info.cwd`)。小账本与「再开一个」用。 */
  cwd?: string
  /** 最近一次往返的错话。屏幕上就地一行,零 Toast。 */
  error?: string
  /** 查找行(T2)。判词整段在 `TerminalFindState` 上。 */
  find: TerminalFindState
}

export interface TerminalSessionDeps {
  port: TerminalPort
  screen: TerminalScreen
}

export class TerminalSession {
  private state: TerminalState = 'attaching'
  private exitCode: number | null | undefined
  private oscTitle = ''
  private fallbackTitle: string
  private cwd: string | undefined
  private error: string | undefined
  private find: TerminalFindState = FIND_CLOSED

  /** 已经画过的最大 seq。去重与回放接口都按它判。 */
  private lastSeq = -1
  /** 当前流控代次。每次 attach +1(服务端发的)。 */
  private generation = 0
  /** 本代还没回执的字节数。 */
  private unacked = 0

  private readonly offs: (() => void)[] = []
  private readonly listeners = new Set<() => void>()
  private snapshot: TerminalSnapshot
  private disposed = false

  constructor(
    readonly id: string,
    private readonly deps: TerminalSessionDeps,
    /** 建这一格时就知道的名字(cwd 末段 / shell 名)。attach 回来会盖掉它。 */
    initialTitle = '',
  ) {
    this.fallbackTitle = initialTitle
    this.snapshot = this.computeSnapshot()

    const { port, screen } = deps
    screen.attachKeyGuard()
    screen.onData((data) => {
      /*
       * **用户按键不过资源管线**(方案 §2.1-8)。它直调 `terminal.write` ——
       * 一次按键要在几毫秒内到达 PTY,而管线那条路上有授权、审计、投影三站。
       * 模型操作终端是另一条路(T3 待拍),两条路那时在**后端**汇合,不在这里。
       */
      void this.send(data)
    })
    screen.onTitleChange((title) => {
      this.oscTitle = title
      this.publish()
    })
    /*
     * 读数订**一次**(与上面两条同一手:一格实例的寿命里只订一回)。装饰关掉时
     * 这一条永不回调 —— 那一档由 `runFind` 的布尔答案兜底,判词在那儿。
     */
    screen.onFindResults(({ index, count }) => {
      if (!this.find.open) return
      this.find = { ...this.find, index, count }
      this.publish()
    })
    this.offs.push(
      port.onData((fact) => {
        if (fact.terminalId !== this.id) return
        this.feed(fact.seq, fact.data)
      }),
    )
    this.offs.push(
      port.onExit((fact) => {
        if (fact.terminalId !== this.id) return
        this.exitCode = fact.exitCode
        this.state = 'exited'
        this.publish()
      }),
    )
  }

  /* ── 读 ──────────────────────────────────────────────────────────────── */

  get element(): HTMLElement {
    return this.deps.screen.element
  }

  get(): TerminalSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /* ── attach ─────────────────────────────────────────────────────────── */

  /**
   * 接上(首载与「点击重连」共用这一只)。
   *
   * 次序即语义:先按 `info` 把网格钉好 → `truncated` 就先全重置 → 逐条回放
   * → 记下 `lastSeq` 与代次 → 账本清零。回放那一段**不记账**(契约原话)。
   */
  async attach(): Promise<void> {
    if (this.disposed) return
    this.state = 'attaching' as TerminalState
    this.error = undefined
    this.publish()
    let answer
    try {
      answer = await this.deps.port.attach(this.id)
    } catch (error) {
      this.state = 'dead'
      this.error = error instanceof Error ? error.message : String(error)
      this.publish()
      return
    }
    if (this.disposed) return
    if (!answer.success) {
      // 账上有这个 id,机器上没有那格 PTY —— 重启之后的残留就是这一档。
      this.state = 'dead'
      this.error = answer.error
      this.publish()
      return
    }
    const { screen } = this.deps
    if (answer.info) {
      screen.resize(answer.info.cols, answer.info.rows)
      this.cwd = answer.info.cwd
      this.fallbackTitle = answer.info.title || this.fallbackTitle
    }
    if (answer.truncated) {
      // ring 绕过一圈:回放可能从一条转义序列的中间开始,先把屏幕打回出厂。
      screen.write('\x1bc')
    }
    for (const chunk of answer.chunks ?? []) screen.write(chunk.data)
    this.lastSeq = answer.lastSeq ?? this.lastSeq
    this.generation = answer.generation ?? this.generation
    this.unacked = 0
    // 这一发在飞的时候 exit 推送可能已经到了 —— 死讯不许被一次迟到的 attach 盖掉。
    if (this.state !== 'exited') this.state = 'live'
    this.publish()
  }

  /* ── 推送到了 ───────────────────────────────────────────────────────── */

  /** 一帧输出。**旧帧一律丢**(判词在文件头「去重按 seq」那一段)。 */
  private feed(seq: number, data: string): void {
    if (this.disposed) return
    if (seq <= this.lastSeq) return
    this.lastSeq = seq
    const units = data.length
    // 代次在这一刻捕获:回调跑起来时可能已经 re-attach 过了(见文件头)。
    const generation = this.generation
    this.deps.screen.write(data, () => this.countAck(units, generation))
  }

  /** 画上去了 —— 记账,攒够阈值回执一次。 */
  private countAck(units: number, generation: number): void {
    if (this.disposed || generation !== this.generation) return
    this.unacked += units
    if (this.unacked < ACK_THRESHOLD_UNITS) return
    const bytes = this.unacked
    this.unacked = 0
    void this.deps.port.ack(this.id, bytes, generation).catch(() => {
      /* 丢一条只是把恢复推迟一拍 —— 世代协议会把账本清零(契约原话)。 */
    })
  }

  /* ── 写 ──────────────────────────────────────────────────────────────── */

  /** 用户敲的一段。`exited` / `dead` 之后一个字节都不发。 */
  private async send(data: string): Promise<void> {
    if (this.state === 'exited' || this.state === 'dead' || this.disposed) return
    try {
      const answer = await this.deps.port.write(this.id, data)
      if (!answer.success) this.markUnreachable(answer.error)
    } catch (error) {
      this.markUnreachable(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 局部键的落点:把 `Ctrl+<字母>` 写成那个控制字节发下去。
   *
   * 派发器已经 `preventDefault` 过这一下(局部键命中即认领),所以 xterm 那条
   * 守卫会让它进不了 PTY —— 这一句就是它的替代路。判词整段在 `key-courtesy.ts`。
   */
  sendCourtesyKey(letter: string): void {
    void this.send(controlByteOf(letter))
  }

  /* ── 查找(T2)────────────────────────────────────────────────────────── */

  /**
   * 开查找行。**已经开着就只是重申**(⌘F 再按一下由叶把光标送回输入框并全选,
   * 那是「落点」的事,不是这一层的)。
   */
  openFind(): void {
    if (this.disposed || this.find.open) return
    this.find = { ...this.find, open: true }
    this.publish()
  }

  /**
   * 收起查找行:清掉高亮,**词留着**(下次开还是它 —— 与浏览器、编辑器一族的
   * 手感一致),读数归零(高亮都没了,再报一个数就是撒谎)。
   */
  closeFind(): void {
    if (this.disposed || !this.find.open) return
    this.deps.screen.clearFind()
    this.find = { ...this.find, open: false, index: -1, count: 0 }
    this.publish()
  }

  /**
   * 人在输入框里打字。空词 = 清高亮(**不是**「找一个空串」),非空 = 就地往下
   * 找一次(增量:选区随着打字长出去)。
   */
  setFindQuery(query: string): void {
    if (this.disposed) return
    this.find = { ...this.find, query }
    if (!query) {
      this.deps.screen.clearFind()
      this.find = { ...this.find, index: -1, count: 0 }
      this.publish()
      return
    }
    this.runFind('next')
  }

  /** 下一处 / 上一处。词空着时一格都不动(那颗钮在叶那边也是禁着的)。 */
  findNext(): void {
    this.runFind('next')
  }

  findPrevious(): void {
    this.runFind('previous')
  }

  /**
   * 真正去找的那一句。
   *
   * **布尔答案只用来兜「零命中」那一档**:装饰开着时读数由
   * `onFindResults` 说了算(它知道总共几处、此刻是第几处),而装饰关掉时那条
   * 事件永不来 —— 这时候至少还答得出「一处都没有」,不至于让屏幕上那一格读数
   * 停在上一次查询的数上。找到了却拿不到读数,就让读数保持原样:编一个
   * 「1/1」出来会让「这台机器上终端色板没加载」这件事永远看不出来。
   */
  private runFind(direction: TerminalFindDirection): void {
    if (this.disposed || !this.find.query) return
    const found = this.deps.screen.find(this.find.query, direction)
    if (!found) this.find = { ...this.find, index: -1, count: 0 }
    this.publish()
  }

  /* ── 尺寸 ────────────────────────────────────────────────────────────── */

  /**
   * 按容器量一次并上报。**量不出来就什么都不做**(9-9:隐藏层里 fit 得 0 列,
   * 一条 `resize(0,0)` 会让 PTY 重排乱屏)。切回来时调用方补一次。
   */
  fit(): void {
    if (this.disposed || this.state === 'exited' || this.state === 'dead') return
    const size = this.deps.screen.fit()
    if (!size) return
    void this.deps.port.resize(this.id, size.cols, size.rows).catch(() => {
      /* 尺寸没报上去只是这一屏排得不对,下一次 fit 会补 —— 不值得改状态。 */
    })
  }

  /* ── 生死 ────────────────────────────────────────────────────────────── */

  /** 显式杀掉这格 PTY(关标签那条路)。 */
  async kill(): Promise<void> {
    try {
      await this.deps.port.kill(this.id)
    } catch {
      /* 杀不掉多半是它已经不在了 —— exit 推送会把状态补上 */
    }
  }

  /** 把键盘交给屏幕里那个收字的元素。名字为什么带 `Screen`,见 `screen.ts`。 */
  focusScreen(): void {
    if (!this.disposed) this.deps.screen.focusScreen()
  }

  /** 主题换了。 */
  refreshFace(): void {
    if (!this.disposed) this.deps.screen.refreshFace()
  }

  /** **只拆这一侧**:销毁屏幕、退订。PTY 一个字都不碰(判词在 ① 生命周期)。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.offs.splice(0)) off()
    this.deps.screen.dispose()
    this.listeners.clear()
  }

  /* ── 内务 ────────────────────────────────────────────────────────────── */

  /** 一发往返报了不成功 —— 这份订阅不再可信。`live` → `detached`。 */
  private markUnreachable(message?: string): void {
    this.error = message
    if (this.state === 'live' || this.state === 'attaching') this.state = 'detached'
    this.publish()
  }

  private computeSnapshot(): TerminalSnapshot {
    return {
      id: this.id,
      state: this.state,
      ...(this.state === 'exited' ? { exitCode: this.exitCode ?? null } : {}),
      // 活标题三档(方案 §2.1-5):OSC 标题 → cwd 末段 → shell 名。
      title: titleOf(this.oscTitle, this.cwd, this.fallbackTitle),
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.error ? { error: this.error } : {}),
      find: this.find,
    }
  }

  private publish(): void {
    this.snapshot = this.computeSnapshot()
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * 活标题三档。**纯函数** —— 叶檐、标签、瓦读的是同一句话,所以它只有一个产地。
 * 三档都空时交空串(调用方回落到瓦表上那个静态名字)。
 */
export function titleOf(osc: string, cwd: string | undefined, shell: string): string {
  if (osc.trim()) return osc.trim()
  const base = cwd ? cwd.replace(/\/+$/, '').split('/').pop() : ''
  if (base) return base
  return shell
}
