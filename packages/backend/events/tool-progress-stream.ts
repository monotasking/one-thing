/**
 * **工具进度活流的发射闸**(C2-b,`apps/desktop-react/docs/workbench-2026-09.md`
 * §6.2 表「执行中」列 / §6.3 / §6.6)。
 *
 * 一次调用**执行中**的过程读数(输出尾行 / 比例 / 一句话)沿 16ms 推屏管道直达
 * 界面的工具卡。它照 `ui-stream.ts` 的样子写:**引擎外的旁路生产者**直接把
 * chunk 推上 `StreamChannel`,谁也不删、谁也不换管 —— 小批走的还是那条
 * `session:stream`(桌面 IPC)/ SSE,消费者(ipc-bridge / SSE)一行不改;
 * 新开手写通道会当场碰红 `transport:gate`。
 *
 * ## 它**不进账本**
 *
 * `events.jsonl` 只由 `wiring/engine/stream/session-event-recorder.ts` 的显式
 * `writeSessionEvent` 产生,StreamChannel 的 chunk 从不落盘 —— 所以这条路天然
 * 不写账本。这不是巧合而是判断:**账本是唯一真相,而进度不是会话的事实,是过程
 * 读数**。重开会话时该看见的是结局(这次调用发生了、参数是什么、结局如何),
 * 不是「当时跑到第 7 行」。三定律因此一格不动。
 *
 * 纪律写成了代码而不是注释:`packages/core/session/session.ts` 的 `applyChunk`
 * 里有一条什么都不做的 `case 'tool-progress'`,`__tests__/tool-progress-stream.test.ts`
 * 里有一条 spy 住 recorder 的用例。
 *
 * ## 开关
 *
 * `ONETHING_TOOL_PROGRESS = 1(默认,缺省即开)| 0`
 *
 * 与 `ONETHING_UI_STREAM` 相反,这一条**默认开**:用户报的正是「流式看不到做了
 * 多少」,默认关等于这个功能不存在。`=0` 是出事时的关灯开关(进度全不出生,
 * 屏幕退回 C2-a 那一形),每次读环境变量而不是启动时定死 —— 与
 * `ONETHING_SESSION_SHADOW` 同一条路数,测试可以就地改档,不必重开进程。
 */

import type { ToolProgressChunk } from '@onething/core/events'
import { getStreamChannel } from './index.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('toolkit.progress')

export function isToolProgressStreamEnabled(): boolean {
  return process.env.ONETHING_TOOL_PROGRESS !== '0'
}

/** 一条进度读数(chunk 上除 `type` / `toolCallId` 之外的那三格)。 */
export interface SessionToolProgress {
  message?: string
  ratio?: number
  outputTail?: string
}

/**
 * 把一条进度推上流管。
 *
 * 与采集点同一条纪律:**发不出去绝不打断这次工具调用**。事件系统没装配(单测、
 * RPC 直调的轻量进程)、通道抛异常,都只留一行 debug —— 进度是读数,读数丢了
 * 屏幕上少一行字,而抛出去会让一次真的工具调用失败。
 *
 * 三格全空的一条不发:那是一条什么都没说的 chunk,推上去只是让每个消费者白跑
 * 一趟。`ratio` 按 [0,1] 夹紧(工具算错了不该让进度条冲出卡外),`NaN` 当没报。
 */
export function pushSessionToolProgress(
  sessionId: string,
  toolCallId: string,
  progress: SessionToolProgress,
): void {
  if (!isToolProgressStreamEnabled()) return
  if (!sessionId || !toolCallId) return
  const ratio = normalizeRatio(progress.ratio)
  const message = progress.message || undefined
  const outputTail = progress.outputTail || undefined
  if (message === undefined && ratio === undefined && outputTail === undefined) return
  const chunk: ToolProgressChunk = {
    type: 'tool-progress',
    toolCallId,
    ...(message !== undefined ? { message } : {}),
    ...(ratio !== undefined ? { ratio } : {}),
    ...(outputTail !== undefined ? { outputTail } : {}),
  }
  try {
    getStreamChannel().push(sessionId, chunk)
  } catch (error) {
    log.debug('tool progress push failed', { sessionId, toolCallId }, error)
  }
}

function normalizeRatio(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}
