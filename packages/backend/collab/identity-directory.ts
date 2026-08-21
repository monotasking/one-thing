/**
 * 身份目录的接线 —— 句柄解码的**识别面**
 * (docs/design/collab-handle-codec.md §2.1)。
 *
 * 纯规则在 `collab/identity.ts`,这里只负责把两个来源接上:全体 agent
 * (`listAgents`)与用户本人(`resolveUserIdentity`)。
 *
 * ## 为什么是"全体",不是"本房成员"
 *
 * 这正是那一整类泄漏的修复点。解码此前用的是 `roomMembers()`,而那份名单同时
 * 扛着两个互不相干的职责 —— **谁能被识别** 与 **谁能被激活**。后者理应严格
 * (在职、在本房),于是前者被一起收窄了:用户、退休成员、非本房成员的句柄
 * "编码发了、解码不认",原样落进转录(实测 35 处)。
 *
 * 识别面收得越全,清理得越干净;而放宽它**不会**让任何人被误唤醒 —— 激活侧
 * 各自 `.filter(memberIds.has(agentId))`(`collab/activation.ts`),非成员进不了
 * 队列。**授权仍旧归成员名单管,这里只回答"这串字符是不是一个真身份"。**
 *
 * ## 为什么每次现算、不缓存
 *
 * 与 `user-identity.ts` 同一条纪律:一份镜像意味着改名/注销之后要有人负责让它
 * 失效,而那个"有人"正是这类 bug 的出处。规模是 agent 总数(几十),做的事是
 * 字符串切片与 Map 装填,相对一次工具调用可忽略。
 */
import {
  collabIdentityFromAgent,
  collabUserIdentity,
  type CollabIdentity,
} from '@onething/runtime/collab'
import { listAgents } from '../wiring/agents/index.js'
import { resolveUserIdentity } from './user-identity.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('collab.identity')


/**
 * 当前可被指认的每一个身份:用户本人 + 全体 agent(**含退休**)。
 *
 * 退休的人照样进目录:出站侧明确规定「退休/离开本群的人照样给句柄」
 * (`handles.ts` 的 `formatCollabAgentHandle`),那么解码就必须认得 —— 编解码
 * 两侧的域不对等,正是这次修的东西。
 */
export function buildCollabIdentityDirectory(): CollabIdentity[] {
  const directory: CollabIdentity[] = []
  // 两个来源各自兜底,而不是让整个目录一起垮:这份名单是**增强**(把句柄剥
  // 干净),不是发言的必经门。读不到用户档案就少剥一种句柄,而一条发不出去的
  // 消息是**用户可见的功能故障** —— 两害相权,永远是后者更贵。
  for (const source of [collectUser, collectAgents]) {
    try {
      directory.push(...source())
    } catch (error) {
      log.warn('identity directory source unavailable, handle stripping degraded', {}, error)
    }
  }
  return directory
}

function collectUser(): CollabIdentity[] {
  const user = resolveUserIdentity()
  return [collabUserIdentity(user.label, user.handle)]
}

function collectAgents(): CollabIdentity[] {
  return listAgents()
    .filter(agent => Boolean(agent?.id?.trim()))
    .map(agent => collabIdentityFromAgent({ id: agent.id, name: agent.name }))
}
