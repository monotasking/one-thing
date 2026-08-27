/**
 * 冷加载补水源(S3w-1,`docs/design/session-event-sourcing-2026-08.md`
 * §14.4 / §15.4;**档位已退役** —— F4-a,§16.12)。
 *
 * LRU 冷加载时,内存 store(写模型)从 `events.jsonl` 的投影补水。那是 §14.1
 * 点名的"S3w 真正要换的那根梁":产品读路早已全线投影(S2b),写模型的**起点**
 * 却还在抄本上。批 3(§15.10)把这里的默认扳到投影,前提是批 1 立的合同门对
 * 全量真机会话绿(436 会话 pass 417 / fail 0 / 0 新类)。
 *
 * 从前这一层还有个岔口 `ONETHING_SESSION_HYDRATE=messages`(回落到
 * `messages.jsonl`)。**F4-a 把它烧了**(§16.11 拍板 5):抄本自批 6a 停写、
 * 批 6b 删码,那根杆扳下去补出来的不是历史,是空 —— 理由见 `read-mode.ts` 的
 * 墓志铭。补水从此无条件走投影,这里只剩一个判据:这条会话的事件里**折不折得出**
 * 历史。
 *
 * 岔口只在这一层:仓库(产品层)只知道"有没有人给我一份消息";
 * 会话外壳(meta.json)不经这条路,换的只是消息那一格。
 */

import type { ChatMessage } from '@shared/ipc.js'
import { eventsListMessages } from './events-reads.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions')

/**
 * 这条会话冷加载时该用的消息。
 *
 * `undefined` 有两种含义,对调用方是同一件事(仓库照旧走它自己的加载):这条
 * 会话的事件里折不出消息(未迁移的老会话 / legacy 整文件 / 只有 E0 七类),或者
 * 物化本身出错。后者额外 warn 一次 —— 它不是"事实在别处",是真出了问题。
 * (第三种含义"档位没开"随 `ONETHING_SESSION_HYDRATE` 一起退役,F4-a。)
 *
 * **位置字段 `seq` 就地摘掉**:投影故意不产出位置(`materializeMessageNode`
 * 的原话:"不再产出位置,避免下一个人拿它当身份"),读路那一刀
 * (`events-reads.ts` 的 `toChatMessage`)是给渲染层的锚点用的。补水进 store
 * 的这一份不带它:写模型的写计划(`dirtySeq`)按数组下标算,从来不读这一格,
 * 而把事件坐标当位置写回 `messages.jsonl` 正是 §14.7 风险①说的形状漂移。
 */
export function hydrateSessionMessagesFromProjection(sessionId: string): ChatMessage[] | undefined {
  let projected: ChatMessage[] | undefined
  try {
    projected = eventsListMessages(sessionId)
  } catch (error) {
    log.warn('projection hydrate failed, leaving the load to the repository', { sessionId }, error)
    return undefined
  }
  if (!projected || projected.length === 0) return undefined
  // 交出去的这一份必须与**活投影彻底断开**(§15.13,refold 门真机首杀)。
  //
  // `materializeMessageNode` 对 `message/imported` 节点是浅展开 —— `steps` 数组和
  // 里面的 step 对象都是活投影节点**本体**;而这条链的下游
  // (`session-repository.loadStoredSession` → `rehydrateSessionFromStorage`)是个
  // **就地**写者(`step.toolCall = linked`)。拿到本体就等于把事件里根本没有的
  // `steps[].toolCall` 写进了活投影,此后 refold(文件全量重折 ≡ 活投影)的不变量
  // 当场破掉 —— 门报的是真事。
  //
  // 隔壁 `sessions/session-dehydrate.ts` 的 `dehydrateProjectedMessages` 早立过同一条
  // 纪律:"rehydrate 就地改对象,所以先 `structuredClone` 一份,绝不动调用方
  // (投影缓存 / 活投影节点)里的那份";S3w-1 开的这条新缝漏了它。
  //
  // 深拷放在这里:冷加载每会话一次,成本吃得起。**不要**挪到 `toChatMessage`
  // (读路热路径,每次读都要走)。
  return structuredClone(
    projected.map(message => {
      const { seq: _position, ...rest } = message as ChatMessage & { seq?: number }
      return rest as ChatMessage
    }),
  )
}
