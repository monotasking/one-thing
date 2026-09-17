import { joinLines, splitLines, type LineEdit } from '@onething/core/text'

/**
 * 编辑器这一侧的文档模型(正本 `docs/todo-editor-2026-09.md` §5 / §6.4)。
 *
 * 一份按行组织的原文,**本地是真相**:打字、拆项、并项、撤销都立刻改这里(乐观),
 * 屏幕从它画;改动被算成 `LineEdit` 排队,停手 400ms 或离开编辑时整批发给后端
 * (`DocumentChannel.submit`),后端按当时的原文对账。
 *
 * 外面(AI 的写文件工具)改了文件时:本地还有没发出去的改动就先等它们落定,
 * 之后再拿后端那一份;本地干净就直接换,并把**新出现的行**记进「刚被改过」,屏幕淡淡闪一下。
 */

export interface SubmitResult {
  readonly conflict: boolean
  readonly revision?: string
}

/** 文档怎么存:待办走 `todo:` 资源,别的文档(查看器里的 .md)换一个实现。 */
export interface DocumentChannel {
  submit(edits: readonly LineEdit[], baseRevision: string): Promise<SubmitResult>
  /** 冲突或出错之后要一份最新的(调用方重读后回头调 `receive`)。 */
  requestReload(): void
}

export type DocumentChangeKind = 'local' | 'server'

export interface DocumentChange {
  readonly kind: DocumentChangeKind
  readonly previous: readonly string[]
  readonly lines: readonly string[]
}

/** 前后两份行 → 一条最小的行编辑(去掉公共头尾)。没变返回 null。 */
export function diffLines(previous: readonly string[], next: readonly string[]): LineEdit | null {
  let head = 0
  while (head < previous.length && head < next.length && previous[head] === next[head]) head++
  let tail = 0
  while (
    tail < previous.length - head && tail < next.length - head
    && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]
  ) tail++
  const expect = previous.slice(head, previous.length - tail)
  const lines = next.slice(head, next.length - tail)
  if (expect.length === 0 && lines.length === 0) return null
  return expect.length === 0 && head > 0
    ? { start: head, expect, lines, anchor: previous[head - 1] }
    : { start: head, expect, lines }
}

/** 这些行里哪几行是「新出现的」(不在旧的那份里,按多重集比较)。 */
export function changedLineIndices(previous: readonly string[], next: readonly string[]): number[] {
  const pool = new Map<string, number>()
  for (const line of previous) pool.set(line, (pool.get(line) ?? 0) + 1)
  const changed: number[] = []
  next.forEach((line, index) => {
    const left = pool.get(line) ?? 0
    if (left > 0) pool.set(line, left - 1)
    else if (line.trim()) changed.push(index)
  })
  return changed
}

export const FLUSH_IDLE_MS = 400

export class EditorDocument {
  private current: string[]
  private revision: string
  private pending: LineEdit[] = []
  private inflight: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private waitingServer: { content: string; revision: string; external: boolean } | null = null
  private readonly listeners = new Set<(change: DocumentChange) => void>()
  private disposed = false
  /** 最近一次提交被判冲突、本地那批改动没能落盘(只报一次,见 `takeLostEdits`)。 */
  private lostEdits = false
  /** 外部改动带来的新行,屏幕据它闪一下。键是行号,值是出现的时刻。 */
  readonly recentlyChanged = new Map<number, number>()

  constructor(content: string, revision: string, private readonly channel: DocumentChannel) {
    this.current = splitLines(content)
    this.revision = revision
  }

  get lines(): readonly string[] {
    return this.current
  }

  get baseRevision(): string {
    return this.revision
  }

  get hasPendingEdits(): boolean {
    return this.pending.length > 0 || this.inflight !== null
  }

  subscribe(listener: (change: DocumentChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 本地改动:整份新行进来,算出行编辑排队。 */
  setLines(next: readonly string[]): void {
    if (this.disposed) return
    const edit = diffLines(this.current, next)
    if (!edit) return
    const previous = this.current
    this.current = next.slice()
    this.pending.push(edit)
    this.emit({ kind: 'local', previous, lines: this.current })
    this.schedule()
  }

  /** 后端的一份(首载、事件后重读、冲突后重读)。 */
  receive(content: string, revision: string, external: boolean): void {
    if (this.disposed) return
    if (this.hasPendingEdits) {
      this.waitingServer = { content, revision, external }
      return
    }
    if (revision === this.revision && joinLines(this.current) === content) return
    const previous = this.current
    this.current = splitLines(content)
    this.revision = revision
    if (external) {
      const at = Date.now()
      for (const index of changedLineIndices(previous, this.current)) this.recentlyChanged.set(index, at)
    }
    this.emit({ kind: 'server', previous, lines: this.current })
  }

  /** 立刻把排着的改动发出去(离开编辑、卸载前)。 */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.inflight) return this.inflight.then(() => (this.pending.length ? this.flush() : undefined))
    if (this.pending.length === 0) return Promise.resolve()
    const batch = this.pending
    this.pending = []
    this.inflight = this.channel.submit(batch, this.revision)
      .then(result => {
        if (result.conflict) {
          this.pending = []
          this.lostEdits = true
          this.channel.requestReload()
        } else if (result.revision) {
          // 后端确认的那一份 = 本地此刻(若期间又攒了新改动,它们还在 pending 里,基于这一版继续发)。
          this.revision = result.revision
          // 等着的那份是这次写之前取的,比本地旧:丢掉。这次写本身会发一条 changed 事件,
          // 数据层据它重读,拿到的才是写完之后的那份(期间若有外部改动,也在那一份里)。
          this.waitingServer = null
        }
      })
      .catch(() => {
        // 发失败(断网):放回队首,下次再发。本地屏幕不动 —— 人刚打的字不许消失。
        this.pending = [...batch, ...this.pending]
        this.channel.requestReload()
      })
      .finally(() => {
        this.inflight = null
        if (this.pending.length) this.schedule()
        else if (this.waitingServer) {
          const next = this.waitingServer
          this.waitingServer = null
          this.receive(next.content, next.revision, next.external)
        }
      })
    return this.inflight
  }

  /**
   * 上一次提交冲突时本地有没有丢掉没落盘的改动。**读一次就清**:它只回答「接下来这一次
   * 后端版本到达时,编辑区里那段字是不是还没存过」—— 除此之外,编辑区里的字一定已经在文件里了。
   */
  takeLostEdits(): boolean {
    const lost = this.lostEdits
    this.lostEdits = false
    return lost
  }

  dispose(): Promise<void> {
    const done = this.flush()
    this.disposed = true
    this.listeners.clear()
    return done
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, FLUSH_IDLE_MS)
  }

  private emit(change: DocumentChange): void {
    for (const listener of this.listeners) listener(change)
  }
}
