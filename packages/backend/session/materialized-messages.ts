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
 * ## 缓存住在节点上(§17.7.1 批 1)
 *
 * 从前这里挂着一本**外挂账**:装配层一个进程级失效号 + 一张按会话 id 的表。
 * 它记的是"整份列表还作不作数",于是活 run 里任何一条 delta 都让**全部**消息
 * 一起重物化(258 条 / 50MB 的会话一次 46ms,`getSession` ~30 次/run,§16.27 六)。
 *
 * 现在缓存跟着**领域对象**走:成品按 `(投影节点, node.rev)` 记住,列表组装 =
 * 对可见节点 map 一次,命中即取。改一条 delta 只让**那一条**节点的号前进
 * (`forWrite`,见 `core/session/projection/reducer.ts`),其余全部命中。
 * 两张表都是 `WeakMap`:节点 / 活投影整份重建时,旧成品随对象一起消失,
 * 没有"谁去清"这个问题 —— 也就没有清漏的可能。
 *
 * 为什么 memo 不放进 core 的 `materializeNode`:那一口的产物取决于**物化选项**
 * (blob 读口),而 refold 那道门与模型历史各自带着自己的选项走同一口。这里
 * 存的是**这条读路**独有的成品(深拷 + 补过水的 `ChatMessage`),所以缓存归
 * 这条读路自己;节点只负责回答"我变过没有"。
 *
 * ## 两条必须写死的纪律(每一条都是真机上换来的)
 *
 * 1. **必须跑补水链。** 投影**故意不带** `steps[].toolCall`(它是运行时游标,
 *    不是账本事实),而冷加载那条路是过了 `rehydrateSessionFromStorage` 才交出去的。
 *    不跑同一条链,物化视图与冷加载视图就是两个形状 —— §16.26 静默期 90 采样里
 *    唯一那条残差正是它。
 * 2. **必须先深拷。** `materializeMessageNode` 对 `message/imported` 是**浅展开**:
 *    `steps` 数组与里面的 step 对象是活投影节点**本体**。而补水链是个**就地**
 *    写者(`step.toolCall = linked`)—— 拿本体就等于把事件里根本没有的字段写进
 *    活投影,refold 那道耐久门当场破(§15.13 真机首杀,同一条链隔壁的
 *    `hydrate.ts` 早立过这条纪律)。
 *
 *    按节点缓存之后这条更要命,所以顺序钉死:**深拷 + 补水都发生在 memo 生成
 *    的那一刻,每条节点一次**。若挪到取 memo 的时候补,补水这个就地写者会写
 *    在缓存的成品上,下一次取到的就是被写过的那一份 —— 缓存当场变成污染源。
 *
 * ## 边界
 *
 * - **不主动建活投影**:没有活投影就返回 `undefined`,调用方保留它自己那一份。
 *   建表要同步读整份文件,而这一口挂在 `getSession` 上。
 * - **折不出消息也返回 `undefined`**:未迁移的老会话 / legacy 整文件 / 刚建的
 *   空会话。它们的消息仍由仓库自己的加载路径负责,与 c4-d 之前逐字相同。
 */

import type { ChatMessage } from '@shared/ipc.js'
import {
  materializeNode,
  type ProjectionMaterializeOptions,
  type ProjectionNode,
  type SessionProjectionState,
} from '@onething/core/session'
import { rehydrateSessionFromStorage } from '@onething/runtime/sessions/session-dehydrate'
import { sessionProjectionOptions } from './projection-blobs.js'
import { getLiveSessionProjection, hasLiveSessionProjection } from './projection-cache.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions')

interface MessageMemo {
  /** 算这一份时那条节点的 `rev`(见 `BaseNode.rev`)。 */
  rev: number
  message: ChatMessage
}

/** 节点 → 它此刻的成品。键是节点对象本身,节点没了成品跟着没。 */
const memos = new WeakMap<ProjectionNode, MessageMemo>()

/**
 * 活投影 → 上一次交出去的那个**数组实例**。
 *
 * 它不是缓存(正确性全在上面那张 memo 表里),是**实例稳定器**:换装点那句
 * `if (next === session.messages) return session` 从前靠整份缓存成立,按节点组装
 * 之后每次都是新数组,会话对象上那一格就每读一次写一次。逐条同一 = 交回上一次
 * 那个数组,读侧看到的与 c4-d 逐字相同。键是活投影 state 对象:整份重建换新
 * state,旧数组随它一起消失。
 */
const lists = new WeakMap<SessionProjectionState, ChatMessage[]>()

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
  // 推进到此刻(drain 尾巴)—— 拿到的 state 上,每条节点的 `rev` 就是此刻的号。
  const state = getLiveSessionProjection(sessionId)
  if (state.nodes.length === 0) return undefined

  let messages: ChatMessage[]
  try {
    const options = sessionProjectionOptions(sessionId)
    messages = []
    for (const node of state.nodes) {
      // `hidden` 是列表成员判据,不进 `rev` —— 每次现问(见 `BaseNode.rev`)。
      if (node.hidden) continue
      messages.push(materializedMessage(node, options))
    }
  } catch (error) {
    // 物化本身出错 = 真出了问题(不是"事实在别处"),记一行,让调用方走老路。
    log.warn('projection materialize failed, leaving the store array as it is', { sessionId }, error)
    return undefined
  }
  if (messages.length === 0) return undefined

  const previous = lists.get(state)
  if (previous && sameMessages(previous, messages)) return previous
  lists.set(state, messages)
  return messages
}

/**
 * 这条节点此刻的成品 —— 命中即取,没中就现算一条并记在节点上。
 *
 * 深拷 + 补水都在**这里**发生(文件头纪律 2):补水是就地写者,挪到取 memo
 * 的时候补就等于往缓存里写。
 */
function materializedMessage(node: ProjectionNode, options: ProjectionMaterializeOptions): ChatMessage {
  const memo = memos.get(node)
  if (memo && memo.rev === node.rev) return memo.message

  // 物化产出的是**活投影本体的浅展开**,先深拷再补水,顺序不可换。
  // 投影不产 `seq`(那是位置,事件坐标才是身份),所以这里也没有那一格要摘 ——
  // 与 c4-d 交出去的那一份逐字相同(它当年摘的是读路自己补上去的那一格)。
  const detached = structuredClone(materializeNode(node, options)) as unknown as ChatMessage
  const rehydrated = rehydrateSessionFromStorage({ messages: [detached] }).messages
  const message = (rehydrated?.[0] ?? detached) as ChatMessage
  memos.set(node, { rev: node.rev, message })
  return message
}

function sameMessages(a: readonly ChatMessage[], b: readonly ChatMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}
