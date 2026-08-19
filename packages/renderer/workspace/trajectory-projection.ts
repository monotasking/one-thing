/**
 * 轨迹面板的投影层(主线 E1)—— 事件日志 → ledger 的**纯函数**。
 *
 * 三条纪律照抄事件日志本身(docs/design/dsh-architecture-adoption-2026-08.md §1.1):
 *
 * 1. **只读事实,时长现算**。日志里没有 duration、没有 status;一行工具调用的
 *    耗时是 `result.time − call.time`,"执行中"是"有 call 没有配到 result"。
 *    这里也**不把算出来的时长写回**任何地方 —— 它只是一次渲染的中间值。
 * 2. **配对靠显式因果**。`tool/result.sourceSeq` 指向它的 `tool/call.seq`;
 *    老记录没带 sourceSeq 时才退回"同 callId + 顺序在后"的兜底,与
 *    `resolveToolCallInspection` 同一口径(两处必须说同一件事)。
 * 3. **分组按 requestIndex**。`request/start` 开一组;组头的模型名取**它之前
 *    最近的一条** `request/header`、工具数取**它之前最近的一条**
 *    `request/tools` —— 两种事件都只在自己变化时追加(目录 40KB 且几乎不变,
 *    system 指纹每次注入都可能变,所以它们各写各的),所以一组的"当时看到的
 *    世界"永远是往回找,不是往后找,而且要**分别**往回找。
 *
 * 纯逻辑:无 Vue、无 DOM、无 IO。面板只负责把它画出来。
 */
import type {
  SessionEventRecord,
  SessionRequestEndUsage,
  SessionTrace,
} from '@shared/ipc/session-events.js'

/** 一次工具调用在 ledger 上的一行(call 与 result 合成一行)。 */
export interface TrajectoryToolRow {
  kind: 'tool'
  /** 行 key = call 事件的 seq(会话内唯一,且不随重渲染变化)。 */
  key: string
  callId: string
  name: string
  /** 参数摘要,给行上那一眼用;完整 payload 在 inspector 里。 */
  argsSummary: string
  callTime: number
  callSeq: number
  resultTime?: number
  isError?: boolean
  /** 没配到 result:执行中,或者进程崩在中途没收尾。两者从日志里分不出来,也不猜。 */
  pending: boolean
}

/** 组内的轻量刻度行(首 token / 请求结束)。 */
export interface TrajectoryTickRow {
  kind: 'tick'
  key: string
  /**
   * 刻度种类。**判据是它,不是 `label`** —— 时间条带要按"首 token 在哪"切
   * assistant 段,拿中文文案去比对等于把一次文案微调变成一次功能回归。
   */
  tickKind: 'first-token' | 'request-end'
  label: string
  time: number
}

export type TrajectoryRow = TrajectoryToolRow | TrajectoryTickRow

export interface TrajectoryGroup {
  key: string
  requestIndex: number
  /** 组头三件套:模型 / provider / system 指纹,取自当时那条 header。 */
  provider: string
  model: string
  systemPromptHash: string
  /**
   * 当时目录里的工具数,取自当时那条 `request/tools`。
   * **拿不到就是 undefined** —— 与 schema unavailable 同一条纪律:没有账就是
   * 没有账,不用 0 冒充"一个工具都没有"。
   */
  toolCount?: number
  /** 该组解析到的 header 事件 seq;没有 header(旧日志)时是 undefined。 */
  headerSeq?: number
  /**
   * 开这一组的那条 `request/start` 的 seq。
   *
   * 它是与轨迹树(S3)对接的**连接键**:`SessionTraceRequest.startSeq` 是同一
   * 个数。不用"第几组"这种位置量 —— 位置会随孤儿组的出现平移,seq 是身份。
   */
  startSeq?: number
  /** 请求开始时刻。孤儿组(没有 request/start)取组内第一条事件的时刻。 */
  startTime?: number
  endTime?: number
  stopReason?: string
  usage?: SessionRequestEndUsage
  rows: TrajectoryRow[]
}

const ORPHAN_GROUP_KEY = 'request-unlogged'

/** 摘要长度:一行 44px 的行高里能读的就这么多,再长也是噪声。 */
const ARGS_SUMMARY_LIMIT = 96

/**
 * 参数摘要。原始串解析得动就拍平成 `k=v · k=v`,解析不动就原样截断 ——
 * **解析失败不是要藏起来的事**:模型写坏 JSON 的那一次,原样正是唯一有用的信息。
 */
export function summarizeToolArguments(argumentsRaw: string): string {
  const raw = (argumentsRaw ?? '').trim()
  if (!raw) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return truncate(collapseWhitespace(raw), ARGS_SUMMARY_LIMIT)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return truncate(collapseWhitespace(String(parsed)), ARGS_SUMMARY_LIMIT)
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}=${collapseWhitespace(stringifyValue(value))}`)
    if (parts.join(' · ').length >= ARGS_SUMMARY_LIMIT) break
  }
  return truncate(parts.join(' · '), ARGS_SUMMARY_LIMIT)
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** 相对耗时。只在这里格式化 —— 时长是派生值,不进任何数据结构。 */
export function formatTrajectoryDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/** 本地时刻(时:分:秒)。事件里存的是 `Date.now()`,呈现才落到时区上。 */
export function formatTrajectoryTime(time: number | undefined): string {
  if (typeof time !== 'number' || !Number.isFinite(time)) return ''
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 事件日志 → 分组后的 ledger。
 *
 * 组的归属按**发生顺序**判:`request/start` 开一组,之后的 tool/tick 落在
 * "当时开着的那一组"里。工具结果常常落在同一次请求的 `request/end` **之后**
 * (模型先说完,工具才执行),所以配对是**全局**找、归属是按 call 所在的组 ——
 * 两者分开,否则跨过 request/end 的那一批工具会被算进下一组。
 */
export function buildTrajectoryGroups(
  events: readonly SessionEventRecord[],
): TrajectoryGroup[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  // callId → 结果事件(显式 sourceSeq 优先;同 callId 多次调用时按顺序各认各的)。
  const resultsByCallSeq = new Map<number, { time: number; isError: boolean }>()
  const looseResults: Array<{ callId: string; seq: number; time: number; isError: boolean }> = []
  for (const event of ordered) {
    if (event.type !== 'tool/result') continue
    if (typeof event.data.sourceSeq === 'number') {
      resultsByCallSeq.set(event.data.sourceSeq, {
        time: event.time,
        isError: event.data.isError,
      })
      continue
    }
    looseResults.push({
      callId: event.data.callId,
      seq: event.seq,
      time: event.time,
      isError: event.data.isError,
    })
  }
  const consumedLoose = new Set<number>()

  const groups: TrajectoryGroup[] = []
  let current: TrajectoryGroup | undefined
  let lastHeader: { seq: number; provider: string; model: string; hash: string } | undefined
  // 目录与信封各走各的"往回找"游标 —— 它们在日志里是两条独立去重的事件流。
  let lastToolCount: number | undefined

  const ensureGroup = (time: number): TrajectoryGroup => {
    if (current) return current
    // 孤儿组:日志里存在 request/start 之前的行(旧日志、崩溃残留)。
    // 造一个显式的"未记账请求"组把它们收下,而不是悄悄丢掉。
    current = {
      key: ORPHAN_GROUP_KEY,
      requestIndex: 0,
      provider: lastHeader?.provider ?? '',
      model: lastHeader?.model ?? '',
      systemPromptHash: lastHeader?.hash ?? '',
      ...(lastToolCount !== undefined ? { toolCount: lastToolCount } : {}),
      ...(lastHeader ? { headerSeq: lastHeader.seq } : {}),
      startTime: time,
      rows: [],
    }
    groups.push(current)
    return current
  }

  for (const event of ordered) {
    switch (event.type) {
      case 'request/tools': {
        lastToolCount = event.data.tools.length
        break
      }
      case 'request/header': {
        lastHeader = {
          seq: event.seq,
          provider: event.data.provider,
          model: event.data.model,
          hash: event.data.systemPromptHash,
        }
        break
      }
      case 'request/start': {
        current = {
          key: `request-${event.data.requestIndex}-${event.seq}`,
          requestIndex: event.data.requestIndex,
          startSeq: event.seq,
          provider: lastHeader?.provider ?? '',
          model: lastHeader?.model ?? '',
          systemPromptHash: lastHeader?.hash ?? '',
          ...(lastToolCount !== undefined ? { toolCount: lastToolCount } : {}),
          ...(lastHeader ? { headerSeq: lastHeader.seq } : {}),
          startTime: event.time,
          rows: [],
        }
        groups.push(current)
        break
      }
      case 'assistant/first-token': {
        ensureGroup(event.time).rows.push({
          kind: 'tick',
          key: `tick-${event.seq}`,
          tickKind: 'first-token',
          label: '首 token',
          time: event.time,
        })
        break
      }
      case 'tool/call': {
        const group = ensureGroup(event.time)
        const paired = resultsByCallSeq.get(event.seq)
          ?? takeLooseResult(looseResults, consumedLoose, event.data.callId, event.seq)
        group.rows.push({
          kind: 'tool',
          key: `call-${event.seq}`,
          callId: event.data.callId,
          name: event.data.name,
          argsSummary: summarizeToolArguments(event.data.argumentsRaw),
          callTime: event.time,
          callSeq: event.seq,
          ...(paired ? { resultTime: paired.time, isError: paired.isError } : {}),
          pending: !paired,
        })
        break
      }
      case 'request/end': {
        const group = ensureGroup(event.time)
        group.endTime = event.time
        if (event.data.stopReason) group.stopReason = event.data.stopReason
        if (event.data.usage) group.usage = event.data.usage
        group.rows.push({
          kind: 'tick',
          key: `tick-${event.seq}`,
          tickKind: 'request-end',
          label: '请求结束',
          time: event.time,
        })
        break
      }
      default:
        break
    }
  }

  return groups
}

function takeLooseResult(
  looseResults: Array<{ callId: string; seq: number; time: number; isError: boolean }>,
  consumed: Set<number>,
  callId: string,
  callSeq: number,
): { time: number; isError: boolean } | undefined {
  for (const candidate of looseResults) {
    if (consumed.has(candidate.seq)) continue
    if (candidate.callId !== callId) continue
    if (candidate.seq < callSeq) continue
    consumed.add(candidate.seq)
    return { time: candidate.time, isError: candidate.isError }
  }
  return undefined
}

/* ────────────────────────────────────────────────────────────────────────────
 * 时间条带(主线 E2)
 *
 * 条带是**同一份投影的第二种排法**,不是第二个数据源:输入就是上面
 * `buildTrajectoryGroups` 的结果,输出是一堆 0..1 的相对位置。布局算在这里,
 * 面板只负责把百分比落成 CSS —— 于是"等宽 / 按时长 / 空闲压缩"全部可被单测钉死,
 * 不用去量 DOM。
 *
 * 两档(dsh 四模式取前两档):
 *  · `sequence`(默认):横轴是**操作序号**,一格一操作,等宽。看结构。
 *  · `duration`:横轴是**真实时刻**,宽度按现算时长成比例;请求组之间的空闲超过
 *    阈值就压成一段固定宽度并留下记号 —— 不压的话一次隔夜的会话会把所有 span
 *    挤成零宽的线。
 *
 * 纪律照旧:**时长现算,一个 duration 字段都不落**。这里算出来的比例是一次渲染
 * 的中间值,谁也不许把它写回 group/row。
 * ──────────────────────────────────────────────────────────────────────────── */

export const TRAJECTORY_TIMELINE_MODES = ['sequence', 'duration'] as const

export type TrajectoryTimelineMode = (typeof TRAJECTORY_TIMELINE_MODES)[number]

/** 泳道。E2 只有两条,组内并行工具**不做泳道分配**,重叠就重叠(见文件末尾注)。 */
export type TrajectoryLaneId = 'assistant' | 'tools'

/**
 * span 的语义种类。
 * - `wait`:request/start → 首 token(等待 / TTFT)
 * - `generate`:首 token → request/end(生成);没有首 token 时退化成整段
 * - `tool`:一次 call/result 配对
 */
export type TrajectorySpanKind = 'wait' | 'generate' | 'tool'

export interface TrajectoryTimelineSpan {
  key: string
  lane: TrajectoryLaneId
  kind: TrajectorySpanKind
  /** 条带上不写字,这行是 tooltip 与读屏用的。 */
  label: string
  /** 所属请求组的 key —— 点击 assistant 段时用它选中组头。 */
  groupKey: string
  /** 工具 span 才有;点它就是选中 ledger 上那一行。 */
  callId?: string
  startTime: number
  /** 没有终点 = 开区间(执行中 / 崩在中途 / 回合被打断没收到 request/end)。 */
  endTime?: number
  open: boolean
  isError: boolean
  /** 相对位置,0..1(容器宽度的比例)。 */
  offset: number
  size: number
}

/** 请求组边界刻度。E2 不画时间标尺,只画"这里换了一次请求"。 */
export interface TrajectoryTimelineTick {
  key: string
  groupKey: string
  requestIndex: number
  label: string
  time?: number
  offset: number
}

/** 被压缩掉的空闲段。`skippedMs` 留着给 tooltip 现算文案 —— 压缩了但不撒谎。 */
export interface TrajectoryTimelineGap {
  key: string
  offset: number
  size: number
  skippedMs: number
}

export interface TrajectoryTimeline {
  mode: TrajectoryTimelineMode
  spans: TrajectoryTimelineSpan[]
  ticks: TrajectoryTimelineTick[]
  gaps: TrajectoryTimelineGap[]
  /**
   * 轴的总量:`duration` 档是压缩后的毫秒数,`sequence` 档是格数。
   * 只给测试和 tooltip 用,不参与布局(布局已经归一化过了)。
   */
  axisTotal: number
}

/** 空闲超过这个数才值得压 —— 两秒以内的间隔本来就该按真实比例看。 */
export const TRAJECTORY_IDLE_THRESHOLD_MS = 2_000

/** 压缩后那一段占的轴量(等价毫秒)。固定值:压缩段之间不该有"谁更长"的暗示。 */
export const TRAJECTORY_IDLE_AXIS_MS = 400

/** 最小可见宽度。0ms 的调用和开区间都得留一道看得见的印子,否则等于没画。 */
export const TRAJECTORY_MIN_SPAN_SIZE = 0.006

interface SpanDraft {
  key: string
  lane: TrajectoryLaneId
  kind: TrajectorySpanKind
  label: string
  groupKey: string
  callId?: string
  startTime: number
  endTime?: number
  open: boolean
  isError: boolean
}

interface GroupDraft {
  group: TrajectoryGroup
  spans: SpanDraft[]
  start: number
  end: number
}

const EMPTY_TIMELINE = (mode: TrajectoryTimelineMode): TrajectoryTimeline => ({
  mode,
  spans: [],
  ticks: [],
  gaps: [],
  axisTotal: 0,
})

/**
 * 分组 → 时间条带。**纯函数**:同样的输入永远同样的输出,不读时钟、不读 DOM。
 */
export function deriveTrajectoryTimeline(
  groups: readonly TrajectoryGroup[],
  mode: TrajectoryTimelineMode,
): TrajectoryTimeline {
  const drafts = groups
    .map(buildGroupDraft)
    .filter((draft): draft is GroupDraft => draft !== undefined)
  if (!drafts.length) return EMPTY_TIMELINE(mode)
  return mode === 'duration' ? layoutByDuration(drafts) : layoutBySequence(drafts)
}

/**
 * 一组的 span 草稿。
 *
 * assistant 段按首 token 切两段;缺首 token 退化成单段,缺 request/end 退化成
 * 开区间 —— **两种缺失都不猜**,日志里没有的东西不补。
 */
function buildGroupDraft(group: TrajectoryGroup): GroupDraft | undefined {
  const spans: SpanDraft[] = []
  const firstToken = group.rows.find(
    (row): row is TrajectoryTickRow => row.kind === 'tick' && row.tickKind === 'first-token',
  )

  if (typeof group.startTime === 'number') {
    if (firstToken) {
      spans.push({
        key: `${group.key}:wait`,
        lane: 'assistant',
        kind: 'wait',
        label: '等待首 token',
        groupKey: group.key,
        startTime: group.startTime,
        endTime: firstToken.time,
        open: false,
        isError: false,
      })
      spans.push({
        key: `${group.key}:generate`,
        lane: 'assistant',
        kind: 'generate',
        label: '生成',
        groupKey: group.key,
        startTime: firstToken.time,
        ...(group.endTime !== undefined ? { endTime: group.endTime } : {}),
        open: group.endTime === undefined,
        isError: false,
      })
    } else {
      spans.push({
        key: `${group.key}:generate`,
        lane: 'assistant',
        kind: 'generate',
        label: '生成',
        groupKey: group.key,
        startTime: group.startTime,
        ...(group.endTime !== undefined ? { endTime: group.endTime } : {}),
        open: group.endTime === undefined,
        isError: false,
      })
    }
  }

  for (const row of group.rows) {
    if (row.kind !== 'tool') continue
    spans.push({
      key: `span-${row.key}`,
      lane: 'tools',
      kind: 'tool',
      label: row.name,
      groupKey: group.key,
      callId: row.callId,
      startTime: row.callTime,
      ...(row.resultTime !== undefined ? { endTime: row.resultTime } : {}),
      open: row.pending,
      isError: row.isError === true,
    })
  }

  if (!spans.length) return undefined

  let start = group.startTime ?? spans[0].startTime
  let end = group.endTime ?? start
  for (const span of spans) {
    start = Math.min(start, span.startTime)
    end = Math.max(end, span.endTime ?? span.startTime)
  }
  return { group, spans, start, end }
}

/** 等宽:一个操作一格,横轴是序号。组内顺序 = assistant 段在前,工具行按发生顺序。 */
function layoutBySequence(drafts: readonly GroupDraft[]): TrajectoryTimeline {
  const flattened = drafts.flatMap(draft => draft.spans)
  const slot = 1 / flattened.length
  const spans = flattened.map((draft, index) => finalizeSpan(draft, index * slot, slot))

  let cursor = 0
  const ticks = drafts.map(draft => {
    const tick = makeTick(draft, cursor * slot)
    cursor += draft.spans.length
    return tick
  })

  return { mode: 'sequence', spans, ticks, gaps: [], axisTotal: flattened.length }
}

/**
 * 真实时间轴。
 *
 * 轴不是"末刻减首刻":组与组之间的长空闲被换成一段固定轴量,组内一律按真实
 * 毫秒。所以轴的单位是"等价毫秒"——组内可信,跨压缩段之间不可加。
 */
function layoutByDuration(drafts: readonly GroupDraft[]): TrajectoryTimeline {
  const placements: Array<{ draft: GroupDraft; axisStart: number }> = []
  const rawGaps: Array<{ axisStart: number; skippedMs: number }> = []
  let cursor = 0

  drafts.forEach((draft, index) => {
    if (index > 0) {
      const idle = draft.start - drafts[index - 1].end
      if (idle > TRAJECTORY_IDLE_THRESHOLD_MS) {
        rawGaps.push({ axisStart: cursor, skippedMs: idle })
        cursor += TRAJECTORY_IDLE_AXIS_MS
      } else if (idle > 0) {
        cursor += idle
      }
    }
    placements.push({ draft, axisStart: cursor })
    cursor += Math.max(draft.end - draft.start, 0)
  })

  // 整条会话发生在同一个毫秒里(或只有开区间)——按比例分等于除以零,退回等宽。
  if (cursor <= 0) return layoutBySequence(drafts)

  const total = cursor
  const spans = placements.flatMap(({ draft, axisStart }) =>
    draft.spans.map(span => {
      const offset = (axisStart + (span.startTime - draft.start)) / total
      const raw = span.endTime !== undefined ? (span.endTime - span.startTime) / total : 0
      return finalizeSpan(span, offset, raw)
    }),
  )

  const ticks = placements.map(({ draft, axisStart }) => makeTick(draft, axisStart / total))
  const gaps = rawGaps.map((gap, index) => ({
    key: `gap-${index}`,
    offset: gap.axisStart / total,
    size: TRAJECTORY_IDLE_AXIS_MS / total,
    skippedMs: gap.skippedMs,
  }))

  return { mode: 'duration', spans, ticks, gaps, axisTotal: total }
}

/** 落到 0..1 上:先给最小宽度,再把整条塞回容器里(offset + size 永远 ≤ 1)。 */
function finalizeSpan(draft: SpanDraft, offset: number, size: number): TrajectoryTimelineSpan {
  const width = Math.min(Math.max(size, TRAJECTORY_MIN_SPAN_SIZE), 1)
  const left = Math.min(Math.max(offset, 0), 1 - width)
  return { ...draft, offset: left, size: width }
}

function makeTick(draft: GroupDraft, offset: number): TrajectoryTimelineTick {
  return {
    key: `tick-${draft.group.key}`,
    groupKey: draft.group.key,
    requestIndex: draft.group.requestIndex,
    label: `#${draft.group.requestIndex}`,
    ...(draft.group.startTime !== undefined ? { time: draft.group.startTime } : {}),
    offset: Math.min(Math.max(offset, 0), 1),
  }
}

/** 在分组结果里按 callId 定位一行 —— **数据层定位**,inspect 跳转不看 DOM。 */
export function findTrajectoryToolRow(
  groups: readonly TrajectoryGroup[],
  callId: string,
): { group: TrajectoryGroup; row: TrajectoryToolRow } | undefined {
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.kind === 'tool' && row.callId === callId) return { group, row }
    }
  }
  return undefined
}

/* ────────────────────────────────────────────────────────────────────────────
 * Run 分组(S3 只读查询面,`docs/design/session-event-sourcing-2026-08.md` §12)
 *
 * 请求组(上面那一层)是 E1 就有的;run 是 T0 才加进事件词表的**上一层**:
 * 一次执行 = 一条用户消息触发的、可能包含多次请求(工具循环 / 重试)的整段。
 *
 * 这里**不重新解析事件**:run 的事实由后端那棵轨迹树(`getTrace`)交付,这个
 * 函数只做一次**连接** —— 按 `request/start` 的 seq 把已有的请求组挂到它所属的
 * run 下面。两份解析会在"哪个请求属于哪次执行"上分叉,而分叉出来的树看上去
 * 和真的一模一样。
 *
 * 老会话(只有 E0 七类、没有 `run/start`)返回**空数组**:面板据此照旧渲染
 * 平铺的请求组。合成一层假的 run 头会让"这条会话记过执行账"这件事说谎。
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TrajectoryRun {
  /** run 的地址(真 runId;后端对合成组用 `legacy:<mid>`)。 */
  key: string
  runId: string
  synthetic: boolean
  kind?: string
  agentId?: string
  provider?: string
  model?: string
  outcome?: string
  /** 触发这次执行的那条用户消息的开头(后端截断过的)。 */
  triggerPreview?: string
  startTime?: number
  endTime?: number
  groups: TrajectoryGroup[]
}

/** 连不上任何 run 的请求组落在这一格里 —— 显式收下,而不是悄悄丢掉。 */
export const TRAJECTORY_UNGROUPED_RUN_KEY = 'run-unlinked'

export function buildTrajectoryRuns(
  groups: readonly TrajectoryGroup[],
  trace: SessionTrace | null | undefined,
): TrajectoryRun[] {
  if (!trace?.hasRunEvents || !trace.runs.length) return []

  const runByStartSeq = new Map<number, string>()
  const runs: TrajectoryRun[] = trace.runs.map(run => {
    for (const request of run.requests) {
      if (request.startSeq !== undefined) runByStartSeq.set(request.startSeq, run.key)
    }
    return {
      key: run.key,
      runId: run.runId,
      synthetic: run.synthetic,
      ...(run.kind !== undefined ? { kind: run.kind } : {}),
      ...(run.agentId !== undefined ? { agentId: run.agentId } : {}),
      ...(run.provider !== undefined ? { provider: run.provider } : {}),
      ...(run.model !== undefined ? { model: run.model } : {}),
      ...(run.outcome !== undefined ? { outcome: run.outcome } : {}),
      ...(run.trigger?.preview ? { triggerPreview: run.trigger.preview } : {}),
      ...(run.startTime !== undefined ? { startTime: run.startTime } : {}),
      ...(run.endTime !== undefined ? { endTime: run.endTime } : {}),
      groups: [],
    }
  })
  const byKey = new Map(runs.map(run => [run.key, run]))

  const leftovers: TrajectoryGroup[] = []
  for (const group of groups) {
    const runKey = group.startSeq === undefined ? undefined : runByStartSeq.get(group.startSeq)
    const run = runKey === undefined ? undefined : byKey.get(runKey)
    if (run) run.groups.push(group)
    else leftovers.push(group)
  }

  // 只保留真的收到组的 run:`?run=`/`--last` 过滤过的树里,别的 run 的组仍在
  // `groups` 里(它来自完整的 `list`),但那些 run 的头这次不该画出来。
  const result = runs.filter(run => run.groups.length > 0)
  if (leftovers.length) {
    result.push({
      key: TRAJECTORY_UNGROUPED_RUN_KEY,
      runId: '',
      synthetic: true,
      groups: leftovers,
    })
  }
  return result
}
