import { create } from 'zustand'
import { DEFAULT_AGENT_ID, isActiveAgent, isColleague } from '@shared/ipc/agents'
import type { AgentDefinition } from '@shared/ipc/agents'
import { agentsPort } from './agents-port'
import { useSessionsSource } from './sessions-source'
import { notify } from '../services/notify'
import { t } from '../i18n'

/**
 * agent 名册的**真数据源**。全应用一个:顶栏切换器从这里取名册,也从这里切人。
 *
 * ── 屏幕要的四格,以及它们的产地 ────────────────────────────────────────
 * `agents.list` 回的是整份 `AgentDefinition`(含 systemPrompt / tools / 权限档)。
 * 屏幕上只用得着身份面的四格,所以投影在这里就把其余的丢掉 —— 与
 * `expose/projection.ts` 是同一条判例:**线上形状 → 屏幕形状只投一次**,
 * 组件拿到的东西里没有一格是它不该看见的。
 *
 * 缺席的格**不画**,不拿默认值去顶:没有 description 就不画那一行小字,
 * 没有 color 就按 id 哈希取一对渐变(渐变对写在 AgentChip.module.css)。
 *
 * ── 谁进名册 ───────────────────────────────────────────────────────────
 * `colleague` 且 `active` 的才进(`@shared/ipc/agents` 的 `isColleague` /
 * `isActiveAgent` —— 判据在契约层,不在这里重写一遍)。理由是契约里写死的:
 * service 角色(radio-dj 之流)有身份面没有社交面,墓碑(retired)更不该被选中。
 * 但**名字查询吃的是全集** —— 当前会话可能正绑在一个已退休的 agent 上,
 * 那时候屏幕该说出它的名字,而不是假装它是默认助手。
 *
 * ── 取数时机 ───────────────────────────────────────────────────────────
 * 连通后拉一次,失败**重试一次**就停。名册不是会话流,它不值得一条无限重试链;
 * 拉不到就是拉不到,菜单里只剩「默认助手」+ 一行灰字,**不假装有名册**。
 */

/** 一个 agent 在**切换器**上的全部事实。产地一律 `agents.list` 的 `AgentDefinition`。 */
export interface AgentOption {
  /** AgentDefinition.id */
  id: string
  /** AgentDefinition.name —— 名字必须是真的,查不到就不画这一行。 */
  name: string
  /** AgentDefinition.description。缺席 = 这一行小字不存在(不占高)。 */
  description: string | null
  /** AgentDefinition.avatar(emoji)。缺席 = 头像画渐变底 + 名字首字。 */
  avatar: string | null
  /** AgentDefinition.color。缺席 = 按 id 哈希取一对固定渐变。 */
  color: string | null
  /** 名册面用得着的两条契约判定,已解析缺省。 */
  colleague: boolean
  active: boolean
}

export type AgentsSourceStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AgentsSourceState {
  status: AgentsSourceStatus
  /** 失败时那句人话;成功后清空。 */
  error?: string
  /** 名册**全集**(含 service 与墓碑)—— 菜单只画 `rosterOf()` 筛出来的那些。 */
  agents: AgentOption[]
  /**
   * 「还没进会话时选的那个人」= 下一条新会话的默认 agent。
   *
   * **D1 开工批把这条留账结清了**:建会话那条路长出来了(expose/store 的
   * `newSession`),它建完就调 `applyPendingAgent(sessionId)` 把这一格读走、
   * 落盘、清空。`SessionsCreateRequest` 至今没有 agentId 这一格,所以落盘走的是
   * 建完之后的 `sessions.updateAgent` —— 与「切人」是同一条写面,不是第二条。
   */
  pendingAgentId: string | null
  /**
   * 刚切完、还没被 `listMeta` 追认的那些。键 = 会话 id。
   *
   * 乐观更新的**唯一**存放处:写成功后当场立牌,`refresh()` 回来把牌撤掉 ——
   * 撤掉之后屏幕读的就是后端事实那一份。写失败当场撤牌 + notify(warn),
   * **绝不留着一块说谎的牌**。
   */
  optimistic: Record<string, string>

  /** 连通后启动:拉一次名册。幂等。 */
  start: () => Promise<void>
  /** 重新拉一次名册(失败重试与手动重来共用)。 */
  refresh: () => Promise<void>
  /**
   * 切人。
   *  - 有会话:调 `sessions.updateAgent` —— **从下一条消息起生效,历史照留**;
   *  - 没有会话:只记 `pendingAgentId`(见上面那条留账)。
   */
  switchAgent: (sessionId: string | null, agentId: string) => Promise<void>
  /**
   * 把 `pendingAgentId` 兑现到刚建出来的那条会话上,然后**无论成败都清空**。
   *
   * 清空是无条件的,理由是这一格的语义:它说的是「**下一条**新会话归谁」——
   * 下一条已经建出来了,这句话就用掉了。写失败时留着它,下下条会话会莫名其妙
   * 地也归那个人,那是一块说谎的牌(与 switchAgent 的乐观牌同一条纪律)。
   * 写失败 notify(warn) —— 会话建成了,只是没归到那个人,不是一次失败的新建。
   */
  applyPendingAgent: (sessionId: string) => Promise<void>
  /** 测试用:回到未启动的干净态。 */
  reset: () => void
}

/** 线上形状 → 屏幕形状。空串一律读作缺席 —— 一个只有空格的名字不是名字。 */
export function toAgentOption(agent: AgentDefinition): AgentOption {
  const clean = (value: string | undefined): string | null => {
    const text = (value ?? '').trim()
    return text ? text : null
  }
  return {
    id: agent.id,
    name: (agent.name ?? '').trim(),
    description: clean(agent.description),
    avatar: clean(agent.avatar),
    color: clean(agent.color),
    colleague: isColleague(agent),
    active: isActiveAgent(agent),
  }
}

/** 菜单上画哪些人:同事 + 在职。判据本身在契约层,这里只是套用。 */
export function rosterOf(agents: readonly AgentOption[]): AgentOption[] {
  return agents.filter((a) => a.colleague && a.active && a.name)
}

/** 按 id 找人 —— 吃**全集**,所以退休的 agent 也说得出名字。 */
export function findAgentOption(
  agents: readonly AgentOption[],
  agentId: string | null,
): AgentOption | undefined {
  if (!agentId) return undefined
  return agents.find((a) => a.id === agentId)
}

/**
 * 这条会话现在归谁 —— **屏幕唯一的判据**。
 *
 * 三层优先级,顺序即真相的新鲜度:刚切的那块牌 → 会话事实 → 默认。
 * `SessionSummary.agentId` 已经把 `'default'` 读成 null(见 expose/projection.ts),
 * 所以这里的 null 就是「默认助手」,不是「不知道」。
 */
export function resolveAgentId(
  optimistic: Record<string, string>,
  sessionId: string | null,
  sessionAgentId: string | null,
): string {
  if (sessionId && optimistic[sessionId]) return optimistic[sessionId]
  return sessionAgentId ?? DEFAULT_AGENT_ID
}

/** 模块级的启动闸 —— 「这一个进程启动过没有」不是可渲染状态。 */
let started = false

export const useAgentsSource = create<AgentsSourceState>()((set, get) => {
  /** 拉一次。回 true = 拿到了。异常与 `success:false` 在这里合成同一件事:没拿到。 */
  async function loadOnce(): Promise<boolean> {
    const port = await agentsPort()
    try {
      const response = await port.list()
      if (!response.success) {
        set({ status: 'error', error: response.error || 'agents.list 未成功' })
        return false
      }
      set({
        status: 'ready',
        error: undefined,
        agents: (response.agents ?? []).map(toAgentOption),
      })
      return true
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  async function load(): Promise<void> {
    set({ status: 'loading' })
    // 失败只重来一次:名册不是会话流,拉不到就老老实实说拉不到。
    if (await loadOnce()) return
    await loadOnce()
  }

  return {
    status: 'idle',
    agents: [],
    pendingAgentId: null,
    optimistic: {},

    start: async () => {
      if (started) return
      started = true
      const port = await agentsPort()
      await port.ready()
      await load()
    },

    refresh: async () => {
      await load()
    },

    switchAgent: async (sessionId, agentId) => {
      if (!agentId) return
      // 还没进会话:这次选择是「下一条新会话归谁」,不写盘也不发请求。
      if (!sessionId) {
        set({ pendingAgentId: agentId })
        return
      }

      const before = get().optimistic
      set({ optimistic: { ...before, [sessionId]: agentId } })

      const rollback = () => {
        set((prev) => {
          const next = { ...prev.optimistic }
          if (sessionId in before) next[sessionId] = before[sessionId]
          else delete next[sessionId]
          return { optimistic: next }
        })
      }

      let failure: string | undefined
      try {
        const port = await agentsPort()
        const response = await port.updateSessionAgent(sessionId, agentId)
        if (!response.success) failure = response.error || t('agent.switchFailed')
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      if (failure) {
        rollback()
        notify({
          level: 'warn',
          source: 'agent.switch',
          title: t('agent.switchFailed'),
          body: failure,
          detail: failure,
        })
        return
      }

      // 对齐:后端认了这件事之后,牌就该撤掉 —— 屏幕从此读的是 listMeta 的事实。
      // 撤牌**在重拉之后**,中间那一段仍由牌顶着,所以脸不会闪回旧的那个。
      await useSessionsSource.getState().refresh()
      set((prev) => {
        const next = { ...prev.optimistic }
        delete next[sessionId]
        return { optimistic: next }
      })
    },

    applyPendingAgent: async (sessionId) => {
      const agentId = get().pendingAgentId
      if (!sessionId || !agentId) return
      set({ pendingAgentId: null })

      let failure: string | undefined
      try {
        const port = await agentsPort()
        const response = await port.updateSessionAgent(sessionId, agentId)
        if (!response.success) failure = response.error || t('agent.switchFailed')
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      if (!failure) return
      notify({
        level: 'warn',
        source: 'agent.switch',
        title: t('agent.switchFailed'),
        body: failure,
        detail: failure,
      })
    },

    reset: () => {
      started = false
      set({ status: 'idle', error: undefined, agents: [], pendingAgentId: null, optimistic: {} })
    },
  }
})
