/**
 * 回合语境的**绑定表**(§2 `context.ts`)。
 *
 * MCP handler 收到调用时手上只有参数 —— 它不知道自己在替谁说话、说进哪间房、
 * 手里那张牌是哪一张。这张表补上这一段:`streamTurn` 开跑时绑定
 * `(agentId, roomSessionId, execSessionId, leaseId)`,收尾时解绑,handler 按
 * **执行会话 id** 取回。
 *
 * ## 为什么是绑定表而不是一个「当前回合」变量
 *
 * v3 的房间回合是并行的(`collab-actor-v3.md`,上限可配),两间房同时各跑一轮
 * 外部回合是日常形状。一个模块级的 `currentTurn` 会被后起的那一轮覆盖掉,而
 * 症状是**一句话落进了错的房**——没有异常、没有红字,只有群里多出一句谁也不
 * 认领的话。所以键必须是执行会话 id:一条会话同时至多一轮(AgentActor 保证),
 * 这就是天然的并发分区。
 *
 * 与 `app/collab/actors/turn-context.ts` 的关系:那张表是 v3 房间自己的登记簿
 * (`send_message` 靠它验票),这张表是**外部通路的那一段**——它记的是「哪条
 * 执行会话此刻有一个活着的宿主工具面」。两者刻意不合并:那张表由引擎回合的生命
 * 周期管,这张由 SDK 回合的生命周期管,两条生命周期在外部通路上并不重合(SDK
 * 进程可能在引擎回合已经收尾之后才吐完最后一条消息)。合并会让「回合结束」这件
 * 事有两个互相不知道的定义。
 *
 * 表的寿命与进程一样长,条目的寿命与一轮回合一样长。`clear` 只给停机与测试用。
 */
import type { HostToolTurnContext } from './types.js'

const bindings = new Map<string, HostToolTurnContext>()

/**
 * 绑定一轮。返回**解绑函数**,必须在回合的 `finally` 里调 —— 一个漏解的条目会
 * 让下一轮之后的迟到调用打在一份过期语境上,而那是最难查的一类串房。
 *
 * 解绑是**按身份**的:只有当表里那条仍是自己绑上去的那条时才删。同一条执行会话
 * 上的下一轮已经覆盖上来的话,这次解绑什么都不该动 —— 否则一次迟到的收尾会把
 * 活着的下一轮的语境删掉。
 */
export function bindHostToolContext(context: HostToolTurnContext): () => void {
  const token = { ...context }
  bindings.set(context.execSessionId, token)
  let released = false
  return () => {
    if (released) return
    released = true
    if (bindings.get(context.execSessionId) === token) {
      bindings.delete(context.execSessionId)
    }
  }
}

/** 这条执行会话此刻有活着的宿主工具面吗?有就把语境给出来。 */
export function resolveHostToolContext(
  execSessionId: string,
): HostToolTurnContext | undefined {
  return bindings.get(execSessionId)
}

/** 现在有几轮在飞(观测 / 测试)。 */
export function activeHostToolContextCount(): number {
  return bindings.size
}

/** 全部忘掉。停机与测试用 —— 它在生产里不可见,而这正是这类缓存长出第二人格的方式。 */
export function clearHostToolContexts(): void {
  bindings.clear()
}
