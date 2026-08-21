/**
 * 一个 agent 的 v3 家当:信箱、账、笔记(docs/design/collab-actor-v3.md §1.2)。
 *
 * ```
 * <store>/agents-v3/<agentId>/
 *   inbox.jsonl     # 持久 mailbox:全部寻址到我的事件(任何房)
 *   inbox.cursor    # 消费游标(账,同步原子写)
 *   state.json      # 水位/折叠缓冲/举手/租约(账)
 *   notebook.md     # 跨房私人笔记
 * ```
 *
 * ## 蓝图修正:这里**没有** `rooms/<roomId>.jsonl`
 *
 * 蓝图 §1.2/§4 原计划把「分区经历流」也放进这个目录,并把既有的执行会话迁过来。
 * 实施决定改为:**经历流就是既有的 per-(agent×房) ChatSession**
 * (`agent-exec-<agentId>-<roomId>`,id 与格式一个字不动),AgentActor 接管它的
 * 所有权。理由不是省事,是**面**:引擎(流式、工具、权限)、会话仓库、UI 的履历
 * 页全部按 ChatSession 工作,另起一份 jsonl 等于要它们全部再认识第二种转录。
 * 保留它 = 引擎零改造 + 经历零迁移,D5 的迁移面因此缩成三件小事(mailbox 初始化、
 * 游标、房间账)。
 *
 * 于是这个目录只放**信箱与笔记**:两样 ChatSession 装不下的东西 —— 一个是跨房的
 * 收件箱(会话是按房分的),一个是跨房的记忆(会话是按房隔离的)。
 *
 * ## 绝不与 v2 抢写同一个文件
 *
 * `agents-v3/` 这个名字里的 v3 是**门牌号不是版本号**:v2 的 agent 家当散在
 * `sessions/agent-exec-*` 与 `agents.json` 里,到 D6 才动。两份账在同一段时间里
 * 都是活的(v2 跑生产,v3 跑测试与重放),共用一个路径的代价是两个进程内的写者
 * 互相覆盖对方的字段 —— 那种事故只在真机上现身,而且长得像「设置没保存」。
 */
import path from 'node:path'

import { DurableMailbox, type ActorEvent } from '@onething/core/actors'
import { readJsonFile, writeJsonFile } from '@onething/core/storage'
import {
  createCollabAgentAccount,
  normalizeCollabAgentAccount,
  type CollabActorVerb,
  type CollabAgentAccount,
} from './index.js'

import {
  getOnethingStorePath,
} from '../../storage/index.js'
/** v3 的 agent 家当都落在 store 根的这个目录下。 */
export const COLLAB_AGENTS_V3_DIR = 'agents-v3'
/** 账文件名。 */
export const COLLAB_AGENT_ACCOUNT_FILE = 'state.json'
/** 笔记文件名。 */
export const COLLAB_AGENT_NOTEBOOK_FILE = 'notebook.md'
/** 信箱文件前缀(`inbox.jsonl` + `inbox.cursor`)。 */
export const COLLAB_AGENT_MAILBOX_NAME = 'inbox'

/** `<store>/agents-v3/<agentId>/`。 */
export function collabAgentActorDir(agentId: string): string {
  return path.join(getOnethingStorePath(), COLLAB_AGENTS_V3_DIR, agentId)
}

/** `<store>/agents-v3/<agentId>/state.json`。 */
export function collabAgentAccountPath(agentId: string): string {
  return path.join(collabAgentActorDir(agentId), COLLAB_AGENT_ACCOUNT_FILE)
}

/** `<store>/agents-v3/<agentId>/notebook.md`。 */
export function collabAgentNotebookPath(agentId: string): string {
  return path.join(collabAgentActorDir(agentId), COLLAB_AGENT_NOTEBOOK_FILE)
}

/**
 * 开一个 agent 的持久信箱。
 *
 * **单消费者** —— 一个 agent 一个心智循环。`DurableMailbox` 自己会在第二次
 * `batches()` 时抛,这里不再加一层锁:两处判定同一件事,漂的那一天不知道信哪个。
 */
export function openCollabAgentMailbox(
  agentId: string,
  options: { now?: () => number; seenWindowSize?: number } = {},
): Promise<DurableMailbox<ActorEvent<CollabActorVerb>>> {
  return DurableMailbox.open<ActorEvent<CollabActorVerb>>({
    dir: collabAgentActorDir(agentId),
    ownerId: agentId,
    name: COLLAB_AGENT_MAILBOX_NAME,
    ...(options.now ? { now: options.now } : {}),
    ...(options.seenWindowSize === undefined ? {} : { seenWindowSize: options.seenWindowSize }),
  })
}

/**
 * 账的存取面。
 *
 * 之所以是接口而不是直接调 fs:金重放要在**没有磁盘**的前提下跑同一个 AgentActor
 * —— 与房间账同一个理由,同一套两个实现。
 */
export interface CollabAgentAccountStore {
  load(agentId: string): CollabAgentAccount
  save(account: CollabAgentAccount): void
}

/** 真机的那一个:同步原子写(`writeJsonFile` = writeFileSync + renameSync)。 */
export function createCollabAgentAccountFileStore(): CollabAgentAccountStore {
  return {
    load(agentId: string): CollabAgentAccount {
      const raw = readJsonFile<unknown>(collabAgentAccountPath(agentId), null)
      return raw === null ? createCollabAgentAccount(agentId) : normalizeCollabAgentAccount(raw, agentId)
    },
    save(account: CollabAgentAccount): void {
      writeJsonFile(collabAgentAccountPath(account.agentId), account)
    },
  }
}

/** 测试与重放的那一个。语义相同,只是重启之后一切归零。 */
export function createCollabAgentAccountMemoryStore(
  seed: Iterable<CollabAgentAccount> = [],
): CollabAgentAccountStore {
  const accounts = new Map<string, CollabAgentAccount>()
  for (const account of seed) accounts.set(account.agentId, account)
  return {
    load(agentId: string): CollabAgentAccount {
      const hit = accounts.get(agentId)
      // 深拷贝一次:不拷的话「落盘」与「内存态」是同一个对象,任何一处就地改写
      // 都会让「重新 load 一次」失去意义 —— 而崩溃恢复测试问的恰恰是这个。
      return hit ? (JSON.parse(JSON.stringify(hit)) as CollabAgentAccount) : createCollabAgentAccount(agentId)
    },
    save(account: CollabAgentAccount): void {
      accounts.set(account.agentId, JSON.parse(JSON.stringify(account)) as CollabAgentAccount)
    },
  }
}
