import { MIN_BUSY_MS, STALL_HARD_MS, STALL_SOFT_MS } from '../../components/motion'
import type { ProjectedToolCall, ToolCardEntry, ToolStepModel } from '../model/segments'
import { toolTone } from './status'

/**
 * 工具卡的**判断**那一半 —— 纯函数,不吃 React、不吃 i18n。
 *
 * 为什么单独成文件:§6.5 那九条纪律里有四条是**判断**(哪一步该露在收起态的活槽位、
 * 这一步够不够格露 busy 形、静默算到哪一档、头行那句话怎么拼),它们全都要能在
 * 单测里逐条钉住。留在组件里的话,唯一的验证手段就是渲染一遍再读 DOM ——
 * 那是拿画面测判断,判断改坏了未必看得出来。
 *
 * 时间一律**从外面传进来**(`now`),不在这里读时钟:读时钟的函数没法钉。
 */

/** 还在跑的那几档(与 `toolTone` 的 busy 同一张表 —— 那里是「画什么色」,这里是「收没收场」)。 */
export function isLiveStep(step: ToolStepModel): boolean {
  return toolTone(step.row.status) === 'busy'
}

/**
 * 一步是**什么时候开始**的。
 *
 * 三个来源按「越贴近这一步越优先」排:引擎记的执行起点 → 参数收齐的时刻 →
 * 建卡的时刻。三个都没有就没有 —— 不拿 `Date.now()` 冒充一个(那会让这一步
 * 永远显得刚开始,快步骤门于是永远关着)。
 */
export function stepStartedAt(call: ProjectedToolCall): number | undefined {
  const source = call as { startTime?: number; receivedAt?: number; timestamp?: number }
  return source.startTime ?? source.receivedAt ?? source.timestamp
}

/**
 * 一步**上一次收到数据**是什么时候(§6.6 活性读数的唯一判据)。
 *
 * 参数流那一段:活尾巴每收到一片 `tool-input-delta` 就写一次 `liveAt`;
 * 执行中:会报进度的工具由 `tool-progress` 活流继续往前推那一格(C2-b 兑现了
 * 这句预告 —— 这个函数一个字都没改)。一个字都不报的工具照旧从**步开始**算,
 * 那是实话不是误报。
 */
export function stepLiveAt(call: ProjectedToolCall): number | undefined {
  const source = call as { liveAt?: number }
  return source.liveAt ?? stepStartedAt(call)
}

/**
 * 静默了多久 —— **从「这台开始等它」起算**。
 *
 * `watchedSince` 是这块屏第一次见到这一步还活着的本机时刻。加这个下限的理由是
 * 一个真实的形:**冷开一条会话**,账本里躺着一次两年前开了头、永远没有结局的
 * 调用(`tool/call` 有、`tool/result` 没有)。它的 `timestamp` 是对端两年前的钟,
 * 直接拿来减此刻,读数会是「已 88541476 秒没收到数据」—— 那句话技术上没说错,
 * 可它不是人要的答案,而且把一个**跨时钟**的差当成了「等了多久」。
 *
 * 加了下限之后两种形各自正确:真在流的那一步,`liveAt` 一直被推到此刻,下限从不
 * 生效;冷开的那一步,从**打开会话**开始计时,五秒后照样说「已 5 秒没收到数据」——
 * 这仍然是实话(它确实一个字都没报),只是钟换成了这台自己的。
 *
 * 取 `max` 而不是只用下限:两者都是本机时刻,而「上一次收到数据」比「开始看着它」
 * 更晚时,晚的那个才是答案。
 */
export function silentMsOf(
  call: ProjectedToolCall,
  watchedSince: number,
  now: number,
): number {
  const liveAt = stepLiveAt(call)
  const since = liveAt === undefined ? watchedSince : Math.max(liveAt, watchedSince)
  return Math.max(0, now - since)
}

export type StallLevel = 'none' | 'soft' | 'hard'

/**
 * 静默了这么久算哪一档。**壳只会说「多久没收到数据」,永远不说「它卡住了」**
 * —— 真正的收场是引擎那一侧的超时与重试,这里只是让那段等待看得见(§6.6)。
 */
export function stallLevel(silentMs: number): StallLevel {
  if (silentMs >= STALL_HARD_MS) return 'hard'
  if (silentMs >= STALL_SOFT_MS) return 'soft'
  return 'none'
}

/** 静默读数上那个 N —— 只到秒,所以它每秒才变一次(10Hz 的时钟不会让它抖)。 */
export function stallSeconds(silentMs: number): number {
  return Math.max(0, Math.floor(silentMs / 1000))
}

/**
 * 这一步够不够格**露出 busy 形**(§6.5 第 7 条快步骤不闪)。
 *
 * 开始后 `MIN_BUSY_MS` 内就收场的(read 与一切瞬时工具都是),整个 busy 形
 * 一帧都不该出现:出现再消失就是闪。所以判据是「它现在还活着,而且才刚开始」
 * —— 时间到了它还活着,那就是真的在跑,露出来。
 *
 * 算不出起点(三个时刻都缺)时按**露出**算:宁可多画一行,不可让一行永远不出现。
 */
export function isBusyRevealed(step: ToolStepModel, now: number): boolean {
  if (!isLiveStep(step)) return true
  const startedAt = stepStartedAt(step.call)
  if (startedAt === undefined) return true
  return now - startedAt >= MIN_BUSY_MS
}

/**
 * 收起态那一行画谁(§6.5 第 6 条**活槽位常驻**)。
 *
 * 「正在跑的那一步,没有正在跑的就是最近收场的那一步」—— 卡在步与步之间**不许**
 * 缩回只剩头行再长出来(样例首版每换一步卡高抖一次)。
 *
 * 快步骤门在这里也要算进来:一步刚开始、还没够格露 busy 形时,槽位仍然留给
 * 上一步的收场形 —— 否则那 250ms 里卡上一行都没有,正是二版量出来的 40↔78 抖动。
 * 一步都没收场过(第一步就在门里)时只好画它 —— 空着比闪更糟。
 */
export function pickSlotStep(
  steps: readonly ToolStepModel[],
  now: number,
): ToolStepModel | undefined {
  const live = steps.find(isLiveStep)
  if (live && isBusyRevealed(live, now)) return live
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (!isLiveStep(steps[i])) return steps[i]
  }
  return live ?? steps[steps.length - 1]
}

/**
 * 头行的摘要句(§6.1)。
 *
 * 由**各步的名**拼:同名连发是「read ×3」,单步先问那一行**自己怎么念**
 * (`row.headLabel`),没自述才回落到「工具名 + 行名」,行名与工具名一样时只说一次。
 *
 * ── 为什么是「问它」而不是「认得它」──────────────────────────────────
 * `bash` 的行名是命令首词(`rg`),按回落规则会读成「bash rg」—— 首词念了两遍。
 * 修法**不是**在这里写 `if (tool === 'bash')`:那一行字面量就是「按能力枚举」,
 * 下一个「行名即动词」的工具接进来要么说错、要么再加一行 if。所以这里只读表,
 * 「我在头行里叫什么」由 presenter 自述(`ToolRowModel.headLabel`)。
 * 于是 §6.1 那句例子在屏幕上就是它写的样子:「rg · read ×3 · edit ChatStream.tsx」。
 *
 * 超过三格折成「+N」(N = 剩下几**步**,不是几格):列到第四个名字读的人就开始
 * **数**而不是读了 —— 三是壳里已经拍过的那个数(旧计数句的 `MAX_NAMES`)。
 */
export function headText(entries: readonly ToolCardEntry[]): string {
  const head = entries.slice(0, HEAD_MAX_ENTRIES)
  const text = head.map(entryText).join(' · ')
  const rest = entries.slice(HEAD_MAX_ENTRIES).reduce((n, entry) => n + entry.count, 0)
  return rest > 0 ? `${text} +${rest}` : text
}

const HEAD_MAX_ENTRIES = 3

function entryText(entry: ToolCardEntry): string {
  // 聚合格照旧念工具名:「×3」说的是这个**工具**来了三次,不是某一行的自述。
  if (entry.count > 1) return `${entry.tool} ×${entry.count}`
  // 先问自述,缺席才回落 —— 空串不算自述(一格空标签会让头行少一格,那是静默出错)。
  const label = entry.row.headLabel
  if (label) return label
  const name = entry.row.name
  return !name || name === entry.tool ? entry.tool : `${entry.tool} ${name}`
}

/**
 * 头行那一叠图标:按**工具种类**首次出现序去重,最多三枚。
 *
 * 去重按种类而不是按步:七次 read 一枚图标就说完了,画七枚只是把「一叠」变成
 * 一堵墙。§6.5 第 9 条那句「只在工具种类集合变化时重画」说的就是这个列表 ——
 * 它由种类推导,种类没变它逐字相同,React 因此不会动那几个节点。
 */
export function headIcons(entries: readonly ToolCardEntry[]): string[] {
  const icons: string[] = []
  for (const entry of entries) {
    const icon = entry.row.icon
    if (!icons.includes(icon)) icons.push(icon)
    if (icons.length === HEAD_MAX_ENTRIES) break
  }
  return icons
}


/* ── 进度(C2-b,§6.2「执行中」列)──────────────────────────────────────── */

/**
 * 一步此刻的进度读数。**只认还在跑的那几步** —— 收场了的行该说成果,不该挂着
 * 一句关于过去的现在时。
 */
export function stepProgress(step: ToolStepModel): ToolProgress | undefined {
  if (!isLiveStep(step)) return undefined
  return (step.call as { progress?: ToolProgress }).progress
}

export type ToolProgress = NonNullable<ProjectedToolCall['progress']>

/**
 * 执行中那一行的摘要句(§6.2 表「执行中」列)。
 *
 * 三级回落,**每一级都是实话**:
 *  1. `outputTail` 的**最后一行** —— 工具此刻真的吐出来的那一行,最贴近「它在
 *     干什么」;
 *  2. `message` —— 工具自述的一句话(bash 是命令,web_open 是「正在打开 …」);
 *  3. `undefined` —— 交回去让调用方用今天那一份(presenter 算出来的参数摘要)。
 *
 * 取最后一行而不是整段:行是**一行**,塞进去的换行会被 `white-space: nowrap`
 * 吃成一个空格,读出来是几行输出黏成的一句乱码。整段留给抽屉。
 */
export function progressSummary(progress: ToolProgress | undefined): string | undefined {
  if (!progress) return undefined
  const tail = lastLine(progress.outputTail)
  if (tail) return tail
  return progress.message || undefined
}

/** 末尾那一行(尾部空行不算 —— 那是行尾的换行,不是一行输出)。 */
export function lastLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const lines = text.replace(/\n+$/, '').split('\n')
  const last = lines[lines.length - 1]?.trim()
  return last || undefined
}

/**
 * 这张卡此刻该不该画底缘那条进度条,画到几成。
 *
 * 判据是**活槽位那一步报了 ratio 没有**:一张卡上同时只有一步在跑(工具是串行
 * 执行的),而进度条说的正是「这一步跑到哪了」。没有活步、活步没报 ratio,
 * 就没有这条 —— **不画一条恒为 0 的条**(那是造事实,§6.2 明写的禁令)。
 */
export function cardProgressRatio(steps: readonly ToolStepModel[]): number | undefined {
  for (const step of steps) {
    const ratio = stepProgress(step)?.ratio
    if (typeof ratio === 'number' && Number.isFinite(ratio)) {
      return Math.min(1, Math.max(0, ratio))
    }
  }
  return undefined
}
