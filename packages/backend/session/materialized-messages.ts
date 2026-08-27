/**
 * **内存 store 的消息数组 = 折叠产物的物化**(F4-c c4-d,§16.27)。
 *
 * 这是 §16.25 第四节拍定的 **B 案:读侧现取 + 版本缓存**。三定律的终局那句
 * "store = fold(事件流),无活窗例外"落到代码上就是这一件:仓库交出会话之前,
 * 把消息那一格换成这里算出来的那一份 —— 从此**折叠产物是唯一的维护者**,
 * 18 个热写端口不再需要往数组里写(它们随本批整批空转)。
 *
 * ## 为什么是读侧现取,不是写侧刷新
 *
 * A 案(每个端口写完把物化盖回 store)在一次 run 里是 O(n²):`updateMessageContent`
 * 本来就每 token 写一次全量正文,再加一次重建 parts/steps/toolCalls 的物化,常数
 * 5–10×。C 案(带节流的写侧刷新)要立一条"store 中途是陈旧的"新语义,那正是
 * §16.17 共存口径的反面。B 的稳态成本是**一次 map 查询 + 一次 `!==`**;实测
 * `getSession` 约 39 次/run(逐 token 的写者走的是仓库自己的读法,不经这条路),
 * 所以物化次数与读次数同阶,不与 token 数同阶(§16.26 读数一)。
 *
 * ## 三条必须写死的纪律(每一条都是真机上换来的)
 *
 * 1. **失效号不是 `lastSeq`。** 提前折的逻辑 delta(c3-a)那一行还压在编码器
 *    写缓冲里 —— `lastSeq` 不动而 state 动了。拿 seq 当版本号会让一整段正文被
 *    缓存吃掉。号由 `liveSessionProjectionVersion` 给(见那一口的注释)。
 * 2. **必须跑补水链。** 投影**故意不带** `steps[].toolCall`(它是运行时游标,
 *    不是账本事实),而冷加载那条路是过了 `rehydrateSessionFromStorage` 才交出去的。
 *    不跑同一条链,物化视图与冷加载视图就是两个形状 —— §16.26 静默期 90 采样里
 *    唯一那条残差正是它。
 * 3. **必须先深拷。** `materializeMessageNode` 对 `message/imported` 是**浅展开**:
 *    `steps` 数组与里面的 step 对象是活投影节点**本体**。而补水链是个**就地**
 *    写者(`step.toolCall = linked`)—— 拿本体就等于把事件里根本没有的字段写进
 *    活投影,refold 那道耐久门当场破(§15.13 真机首杀,同一条链隔壁的
 *    `hydrate.ts` 早立过这条纪律)。
 *
 * ## 边界
 *
 * - **不主动建活投影**:没有活投影就返回 `undefined`,调用方保留它自己那一份。
 *   建表要同步读整份文件,而这一口挂在 `getSession` 上。
 * - **折不出消息也返回 `undefined`**:未迁移的老会话 / legacy 整文件 / 刚建的
 *   空会话。它们的消息仍由仓库自己的加载路径负责,与 c4-d 之前逐字相同。
 */

import type { ChatMessage } from '@shared/ipc.js'
import { rehydrateSessionFromStorage } from '@onething/runtime/sessions/session-dehydrate'
import { eventsListMessages } from './events-reads.js'
import {
  getLiveSessionProjection,
  hasLiveSessionProjection,
  liveSessionProjectionVersion,
} from './projection-cache.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions')

interface MaterializedEntry {
  version: number
  messages: ChatMessage[]
}

const cache = new Map<string, MaterializedEntry>()

/**
 * **归约器那一步不换装**的嵌套计数(F4-c c4-d,§16.27 第二节)。
 *
 * 一条命令的执行序是 **判据(读 store)→ 事件 append(F1 同步可见)→ 老 reducer
 * 应用到 store**。换装一接上去,reducer 自己那次 `getSession` 就落在**自己刚写的
 * 那条事件之后** —— 它于是在已经折好的数组上把同一条命令再应用一次:
 *
 *  - `appendMessage`:数组里多出一份重影(下一次换装才被冲掉);
 *  - `deleteMessage` / `truncateFrom`:目标**已经不在**了,`findIndex === -1`
 *    当场判 `changed:false` —— 命令的返回值变成"没改成",连带 `updatedAt` /
 *    用量结算 / 索引计数 / 落盘计划**整批不发生**。`retry-message` 的红正是它:
 *    引擎见 `deleteMessageAndTruncate` 返回 false,当场 `Message not found` 收工,
 *    账本上只剩一条 `message/deleted`,新 run 一条都没开(实测复现)。
 *
 * 所以定格**只圈归约器那一步**:它前面的判据 / 底稿取材照旧现取(要的就是此刻
 * 那一份),它自己看到的则是**事件之前**那一份 —— 也就是紧邻它的那次判据读刚
 * 换装上去的那一份。定格不跨 `await`(`replaceAll` 只圈同步那一半),不然就成了
 * §16.25 拒掉的 C 案:"store 中途是陈旧的"。
 *
 * 计数而不是布尔:命令之间可能嵌套。
 */
let pinDepth = 0

/**
 * 跑归约器那一步:段内 `materializeSessionMessages` 一律**不换装**
 * (见 `pinDepth`)。同步段专用 —— 不要把 `await` 圈进来。
 */
export function withSessionCommandPin<T>(fn: () => T): T {
  pinDepth += 1
  try {
    return fn()
  } finally {
    pinDepth -= 1
  }
}

/**
 * 这条会话此刻的消息 —— 从活投影物化,按失效号缓存。
 *
 * `undefined` = 这条会话没有可用的折叠产物(没有活投影 / 事件里折不出消息),
 * 调用方照旧用它自己那一份。
 */
export function materializeSessionMessages(sessionId: string): ChatMessage[] | undefined {
  // 命令段内定格(见 `pinDepth`):`undefined` = 保留调用方手里那一份,而那一份
  // 正是进段之前的折叠产物。
  if (pinDepth > 0) return undefined
  // 不主动建表(见文件头「边界」)。
  if (!hasLiveSessionProjection(sessionId)) return undefined
  // 先推进到此刻(drain 尾巴),再问号 —— 顺序反了会拿到推进前的号,缓存就成了
  // "上一刻的那一份"。
  getLiveSessionProjection(sessionId)
  const version = liveSessionProjectionVersion(sessionId)
  if (version === undefined) return undefined

  const cached = cache.get(sessionId)
  if (cached && cached.version === version) return cached.messages

  let projected: ChatMessage[] | undefined
  try {
    projected = eventsListMessages(sessionId)
  } catch (error) {
    // 物化本身出错 = 真出了问题(不是"事实在别处"),记一行,让调用方走老路。
    log.warn('projection materialize failed, leaving the store array as it is', { sessionId }, error)
    return undefined
  }
  if (!projected || projected.length === 0) return undefined

  // 纪律 3(先深拷)与纪律 2(跑补水链),顺序不可换:补水是就地写者。
  // `seq` 就地摘掉:那是读路给渲染层锚点用的事件坐标,写模型的写计划按数组下标
  // 算,从来不读这一格(与 `hydrate.ts` 同一条理由)。
  const detached = structuredClone(
    projected.map(message => {
      const { seq: _position, ...rest } = message as ChatMessage & { seq?: number }
      return rest as ChatMessage
    }),
  )
  const messages = (rehydrateSessionFromStorage({ messages: detached }).messages ?? detached) as ChatMessage[]

  cache.set(sessionId, { version, messages })
  return messages
}

/** 会话删除 / 测试:丢掉物化缓存。 */
export function resetMaterializedSessionMessages(sessionId?: string): void {
  if (sessionId) {
    cache.delete(sessionId)
    return
  }
  cache.clear()
}
