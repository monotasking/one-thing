/**
 * **端口事实断言**(F4-c c4,§16.24)——「这一格,折叠已经覆盖了吗?」
 *
 * ## 它取代了什么
 *
 * §16.23 的 18 端口分类表把 12 个 `sessionMessageRuntime` 端口判成 **A 类:事实
 * 已经在流上**——`tool/*`、`request/response.usage`、`skill/activated`、
 * `context/turn-update`、`run/end.error` 各有产地,投影 reducer 早就折了它们,
 * 端口那一次写 store 只是**同一个事实的第二个落点**。
 *
 * 那句"早就折了"从前的证据是**恒等门**:每个 run 收尾拿整条消息 canonical 比
 * 一次。c4 把恒等门退役了(读侧只剩投影一条路,验证器侧没有了消费者),那句话
 * 就需要一个**逐口、逐格**的替身 —— 否则它退化成一句相信。
 *
 * 这个文件就是那个替身:端口被调用的**那一刻**,拿它的入参与活投影上同一条消息
 * 的同一格比一次。不等 = 事实与写路分岔,当场红出来。
 *
 * ## 三条边界(每一条都是从 c3-a 探针的三个坑里长出来的)
 *
 * 1. **默认关,生产零成本**。开关是 `ONETHING_SESSION_PORT_ASSERT`
 *    (`1|true|on` 开 / `0|false|off` 关),缺省跟 `ONETHING_SESSION_FREEZE`
 *    的默认走(= vitest 下开,其余关)。关着的时候第一行就 return,连活投影
 *    都不去问。
 * 2. **不主动建表**。没有活投影的会话直接跳过 —— `getLiveSessionProjection` 会
 *    同步读整份文件建表(§16.23 探针坑 3),挂在逐 token 的写路径上就是每次写
 *    一遍全文件 IO,而且会改变产品自己的建表时机。
 * 3. **永不抛进引擎**。不等只记一行 `session-shadow.jsonl`(`kind: 'port'`)
 *    与一个计数,与 refold 同一份账、同一个 2KB 摘要器。断言算错了最坏的结果是
 *    账记歪,绝不能是聊天挂掉 —— 与恒等门第一条纪律逐字相同。
 * 4. **判据只有一把尺**:`canonicalChatMessage`(恒等门的第三条纪律,一字未变)。
 *    两侧各包成一条 `{ [fact]: value }` 的单格消息过同一把尺再比 —— 不在这里
 *    手写任何豁免。第一版没这么做,battery 当场报了 265 条 `usage.durationMs`
 *    的假红(那一格 canonical 早就明文丢掉:一次流的墙钟量测,不是用量)。
 *
 * ## 为什么只有四个端口在这张表上
 *
 * 断言要成立,得先有**一格干净的 1:1 折叠落点**。今天满足的是四格:
 *
 * | 端口 | 比的那一格 | 账本产地 |
 * |---|---|---|
 * | `updateMessageUsage` | `node.usage` | `request/response.usage` 求和 |
 * | `updateMessageSkill` | `node.skillUsed` | `skill/activated` |
 * | `updateMessageError` | `node.errorDetails` | `run/end.error.message` |
 * | `updateMessageTurnContext` | `node.turnContext` | `context/turn-update` |
 *
 * 剩下的按**为什么不比**分成三堆,每一堆的理由都不是"懒得比":
 *
 * - **`content` / `reasoning`**(B 类):c3-a 已经把它们量到 `reasoning` 0 /
 *   `content` 8/124(§16.23 第三节),残差 8 是 C 类「另有产地」的生图与压缩卡片
 *   正文 —— 那是一次**产地裁定**(§16.23 第四节留给用户),不是这里该判的不等。
 *   放进来 = 每次压缩都红一条,把真的不等淹掉。
 * - **`isStreaming`**(D 类):端口被调用的那一刻(`finalize()`,`false`)
 *   run **还没闭**,折叠侧此刻恒为 `true`。这不是分岔,是两个时刻
 *   (§16.23 第五节的反证)。
 * - **`steps` / `toolCalls` / `contentParts` / `steps[].usage`**(A 类的数组半边):
 *   它们的正确判据是**整条消息的 canonical 相等**,而那正是刚退役的恒等门。
 *   在这里手写第二个数组判官 = 把那道门换个名字再建一遍(而且必然与
 *   `canonicalChatMessage` 的豁免表分叉)。它们的账在 §16.24 的告别对账读数里,
 *   往后由 refold 守账本↔投影那一半。
 *
 * 这张表**只增不减**:哪天某个数组端口找到了干净的逐格落点,加一行;绝不为了
 * "覆盖率好看"把判据放宽。
 *
 * ## 加一行之前先问:那一格在 `ProjectionNode` 上真的存在吗
 *
 * c4 施工时拿 `content` / `reasoning` 试过一次:两口都挂上断言、battery 跑完
 * `portMismatches` **0**。读数看着漂亮,其实**什么都没证明** ——
 * `AssistantNode` 上根本没有这两格(正文住 `parts: Map<number, PartState>`),
 * 断言每一次都在 `folded === undefined` 那一行就 return 了。
 *
 * 所以这里记 `portChecks`:**真的比过几次**。它与 `refoldChecks > 0` 是同一条
 * 纪律 —— "那道门根本没跑"与"那道门全绿"在报表上长得一模一样,得有个数把它们
 * 分开。加新一行的人请先看着这个数涨。
 */

import { canonicalChatMessage } from '@onething/core/session'
import { deepEqual, summarizeShadowDiff, appendSessionShadowLine } from './shadow.js'
import { bumpSessionShadowStats, isSessionShadowEnabled } from './event-stats.js'
import { hasLiveSessionProjection, peekSessionProjection } from './projection-cache.js'
import { isSessionFreezeEnabled } from './freeze.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

const TRUTHY = new Set(['1', 'true', 'on', 'yes'])
const FALSY = new Set(['0', 'false', 'off', 'no'])

function readEnvFlag(): boolean | undefined {
  const raw = typeof process !== 'undefined' ? process.env?.ONETHING_SESSION_PORT_ASSERT : undefined
  if (!raw) return undefined
  const value = raw.trim().toLowerCase()
  if (TRUTHY.has(value)) return true
  if (FALSY.has(value)) return false
  return undefined
}

let override: boolean | undefined = readEnvFlag()

/** 仅测试:临时开关(不改环境变量)。 */
export function setSessionPortAssertEnabled(next: boolean | undefined): void {
  override = next
}

export function isSessionPortAssertEnabled(): boolean {
  return override ?? isSessionFreezeEnabled()
}

/** 断言表上的那几格(值就是 `ProjectionNode` 上的字段名)。 */
export type SessionPortFact = 'usage' | 'skillUsed' | 'errorDetails' | 'turnContext'

/**
 * 同一条消息的同一格只报一次 —— 一次分岔在一个 12 轮的 run 里会被原样记 12 次,
 * 那只会把日志变成第二份数据(F9 那条判例的同一个道理)。
 */
const MAX_REMEMBERED = 500
const reported = new Set<string>()

/** 仅测试 / 会话删除:忘掉"这一格已经报过了"。 */
export function resetSessionPortAssertDedupe(): void {
  reported.clear()
}

/**
 * 端口写下 `value` 的这一刻,活投影上同一条消息的 `fact` 那一格是同一个值吗?
 *
 * 跳过(不记账、不算数)的三种情形:这个开关关着 / 这条会话还没有活投影 /
 * 这条消息还不在投影上(端口比 `run/start` 早的那一小段窗口,与 §16.20 第三节
 * 同型)。
 */
export function assertPortFactIsFolded(
  sessionId: string,
  messageId: string,
  fact: SessionPortFact,
  value: unknown,
): void {
  if (!isSessionPortAssertEnabled()) return
  try {
    // 边界 2:不主动建表。没有活投影就没有可比的东西。
    if (!hasLiveSessionProjection(sessionId)) return
    const state = peekSessionProjection(sessionId)
    const node = state?.byMessageId.get(messageId) as Record<string, unknown> | undefined
    if (!node) return
    const folded = node[fact]
    // `undefined` = 折叠侧此刻还没有这一格(产地事件还没落账)。它与"折出来是
    // 另一个值"不是一回事:前者是时刻,后者才是分岔。
    if (folded === undefined) return
    // **自证**:真的比过一次。少这个数,"这一格从来没进过比较"与"比了全对"在
    // 报表上长得一模一样 —— c4 的 `content` / `reasoning` 探针正是这么栽的:
    // `AssistantNode` 上根本没有这两格(正文住 `parts`),断言每次都在上一行
    // return,而 `portMismatches` 照样是 0。读数因此**什么都没证明**(§16.24)。
    bumpSessionShadowStats({ portChecks: 1 })

    // **判据只有一把尺**:`canonicalChatMessage`(恒等门那条纪律,一字未变)。
    // 这里绝不自己写第二套豁免 —— 第一版就是这么栽的:直接 `deepEqual` 之后
    // battery 报了 265 条 `usage.durationMs`,而那一格 canonical 早就明文丢掉
    // ("一次流的墙钟量测,不是用量",`canonical.ts:233`)。手写的第二个判官
    // 一定会与它分叉,分叉的方向永远是"报一堆假红,把真的那条淹掉"。
    const a = canonicalChatMessage({ [fact]: folded })
    const b = canonicalChatMessage({ [fact]: value })
    if (deepEqual(a, b)) return

    const key = `${sessionId}|${messageId}|${fact}`
    if (reported.has(key)) return
    if (reported.size >= MAX_REMEMBERED) reported.clear()
    reported.add(key)

    const { diff, truncated } = summarizeShadowDiff(a, b)
    if (isSessionShadowEnabled()) {
      appendSessionShadowLine({
        time: Date.now(),
        sessionId,
        kind: 'port',
        diff,
        ...(truncated ? { truncated } : {}),
      })
      bumpSessionShadowStats({ portMismatches: 1 })
    }
  } catch (error) {
    // 边界 3:永不抛进引擎。
    log.warn('port fact assertion failed', { sessionId, fact }, error)
  }
}
