import { create } from 'zustand'
import { DEFAULT_AGENT_ID, isActiveAgent, isColleague } from '@shared/ipc/agents'
import type { AgentDefinition } from '@shared/ipc/agents'
import { createMutation, createQuery, useQuery } from './kernel'
import type { Mutation } from './kernel'
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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(09-01 用户令,施工纪律第一条)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这个文件是**一读一写两条线**,所以每一栏都分着说。
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载    —— import 只建一只 query + 一只 mutation,**零往返、零订阅**;
 *  · 首载    —— `start()`(main.tsx 在连通之后调一次):等传输面 ready →
 *                `ensure()` 拉一次名册。模块级 `started` 闸保证一个进程只跑一遍
 *                (这一格不是可渲染状态,所以不进 store);
 *  · 换宿主  —— 名册是**全应用一份**,不跟会话走,所以它没有「换宿主」这件事。
 *                跟着会话走的是「这条会话归谁」,而那一格的产地是 sessions-source
 *                的事实 + 这里的乐观牌,不是名册;
 *  · 写      —— 一次切人的寿命:立牌 → 写 → (成)重拉会话表、撤牌 /
 *                (败)撤牌 + notify(warn)。**牌绝不留过夜**;
 *  · 卸载    —— `reset()`:启动闸、query、mutation、pendingAgentId、乐观表
 *                一起归零。HMR dispose 复用的就是它。
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 *  · empty    —— 名册为空 → 菜单里只有「默认助手」+ 一行「名册不可用」灰字。
 *                **不拿空列表冒充「你只有默认助手」**;
 *  · loading  —— 只有首载算(`phase === 'initial'` 且 `inflight`);那一程灰字
 *                不出现(还没问完,说「不可用」是抢答);
 *  · ready    —— 有过一次名册就永远是它。**重拉保旧**(律②)—— 从前是
 *                `set({status:'loading'})` 之后 data 照留,迁后由 kernel 的
 *                keep-previous 保证,不再依赖「这里恰好没写 agents: []」;
 *  · error    —— 后端原话落在 `agentsQuery.get().error`,与上一份名册**并存**。
 *                屏幕上今天只用它的「有没有」(空名册 + 不在飞 = 画灰字);
 *  · 超量     —— 名册是人数量级的表(十几条),不设削量。真长到要削的那天,
 *                削的是菜单不是这里。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 * 控件在 `components/AgentChip.tsx`,这里只说这一层交出去的读数:
 *  · rest/hover/focus —— 徽与菜单项自己的配方(ButtonBase / MenuItem);
 *  · **pending** —— `useAsyncPending(agentMutation, switchKey(sessionId))`:
 *                在飞时徽上 `aria-busy`,并且**挡住同一条会话的第二发**
 *                (律③要的「反馈长在发起它的那个控件上」+ 逐格,不是整面禁灰);
 *  · disabled —— 徽本身永不禁用(禁了就连菜单都开不了);菜单里「管理 Agents…」
 *                是恒 disabled 的那一条,与本批无关。
 * ══════════════════════════════════════════════════════════════════════════
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

export interface AgentsSourceState {
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

/* ── 读:一只 query ─────────────────────────────────────────────────────── */

/**
 * 名册的取数口。全应用一格,所以是 `createQuery` 而不是一族。
 *
 * **「失败只重来一次」这条纪律搬进了 fetcher**,理由是 kernel 不重试(它只管
 * 折叠、缓存与保旧)—— 而这一条是**这块面的判据**,不是取数原语的通性:
 * 名册不是会话流,它不值得一条无限重试链;两发都没拿到就老老实实说拉不到。
 *
 * 抛出去(而不是回一份空表)也是判据:`success:false` 是「后端说不行」,
 * 回空数组会把「拉不到」画成「你只有默认助手」—— 那是编。抛出去之后 kernel
 * 记进 `error` 并**留住上一份名册**(错误与旧数据共存)。
 *
 * 投影(`AgentDefinition` → `AgentOption` 六格)就在这里做完:**线上形状 →
 * 屏幕形状只投一次**,组件拿到的东西里没有一格是它不该看见的。
 */
export const agentsQuery = createQuery<readonly AgentOption[]>('agents.roster', async () => {
  const port = await agentsPort()
  const once = async (): Promise<readonly AgentOption[]> => {
    const response = await port.list()
    if (!response.success) throw new Error(response.error || 'agents.list 未成功')
    return (response.agents ?? []).map(toAgentOption)
  }
  try {
    return await once()
  } catch {
    // 第二发**不接**:它抛出去的那句就是最后那句原话。
    return await once()
  }
})

/** 名册为空时交出去的那一份 —— 恒等引用,免得每次渲染都换一张新空表(律④)。 */
const NO_AGENTS: readonly AgentOption[] = []

/* ── 写:一只 mutation,一个格 ──────────────────────────────────────────── */

/** 忙态格子的**唯一词表**。store 记账与组件读账共用它 —— 两头各拼一次就是两处会漂。 */
export function switchKey(sessionId: string): string {
  return `switch:${sessionId}`
}

/**
 * 一次写要带的全部东西。两口一个联合,`kind` 同时是分派与「立不立牌」的产地:
 *  · `switch` —— 用户在菜单里点了一个人。立乐观牌,写完重拉会话表再撤牌;
 *  · `apply`  —— 新会话建出来之后兑现 `pendingAgentId`。**不立牌、不重拉**
 *                (语义逐字保留:那条路刚刚才 create + refresh 过一遍,
 *                 再补一发对账是白跑一趟往返)。
 *
 * 两口共一只 mutation 的理由:失败那句话只该有一处产地。从前它在两个 action
 * 里各抄了一遍 try/catch + notify,那正是「同一句话在两处会漂」的形状。
 */
export type AgentWrite =
  | { kind: 'switch'; sessionId: string; agentId: string }
  | { kind: 'apply'; sessionId: string; agentId: string }

/**
 * 最近一次**对账**(settle 里那发重拉 + 撤牌)的把手。
 *
 * 为什么需要它:`createMutation` 的 settle 是**不被 await 的** —— 对账是后台的事,
 * 不该把控件多按住一拍(理由写在 kernel 的 `mutation.ts` 里)。但撤牌这一步
 * **必须排在重拉之后**:中间那一段仍由牌顶着,脸才不会闪回旧的那个。而
 * `switchAgent` 对调用方(以及用例)是有承诺的 —— 所以两件事各归各位:
 * **控件**的忙态在 settle 之前解除(律③要的那一拍),**action 自己**多等这一口。
 * 与 `workspace/store.ts` 的 `reconcile` 逐字同形。
 */
let reconcile: Promise<void> | undefined

/** 撤牌。成功走对账那一路,失败走 optimistic 交出来的回滚 —— 两条路不共用一份代码。 */
function dropOptimistic(sessionId: string): void {
  useAgentsSource.setState((prev) => {
    if (!(sessionId in prev.optimistic)) return prev
    const next = { ...prev.optimistic }
    delete next[sessionId]
    return { optimistic: next }
  })
}

/*
 * 类型**显式写出来**,不靠推断:这只 mutation 与下面那只 store 互相引用
 * (它 setState 立牌撤牌;store 的两个 action 又调它的 run)。运行期没问题
 * (两边都是**调用时**才碰对方),但 TS 的推断会绕成一个环 —— 一句注解就把环
 * 剪断,与 `workspace/store.ts` 同一处判例。
 */
export const agentMutation: Mutation<AgentWrite, void> = createMutation<AgentWrite, void>(
  'agents.switch',
  {
    key: (input) => switchKey(input.sessionId),

    optimistic: (input) => {
      // 兑现那一路不立牌:会话刚建出来,屏幕上还没有一张要顶的脸。
      if (input.kind !== 'switch') return
      const before = useAgentsSource.getState().optimistic
      useAgentsSource.setState({ optimistic: { ...before, [input.sessionId]: input.agentId } })
      // 交出去的这个函数**就是**回滚 —— 补丁与它的撤销出自同一处,不会漂开。
      return () => {
        useAgentsSource.setState((prev) => {
          const next = { ...prev.optimistic }
          if (input.sessionId in before) next[input.sessionId] = before[input.sessionId]
          else delete next[input.sessionId]
          return { optimistic: next }
        })
      }
    },

    run: async (input) => {
      const port = await agentsPort()
      const response = await port.updateSessionAgent(input.sessionId, input.agentId)
      // 「后端说没成」与「这一发抛了」在这条原语里是同一件事:都得走 onError。
      // 兜底话原样保留:后端没给原话时,那句人话本身就是能说的全部。
      if (!response.success) throw new Error(response.error || t('agent.switchFailed'))
    },

    settle: (_result, input) => {
      if (input.kind !== 'switch') return
      reconcile = (async () => {
        // 对齐:后端认了这件事之后,牌就该撤掉 —— 屏幕从此读的是 listMeta 的事实。
        // 撤牌**在重拉之后**,中间那一段仍由牌顶着。
        await useSessionsSource.getState().refresh()
        dropOptimistic(input.sessionId)
      })()
    },

    // 回滚已经由 kernel 在这之前跑过了(「屏幕上不许留一张后端没认下的牌,
    // 哪怕只留一帧」)。这里只剩说出来那一半 —— 后端原话原样进 body 与 detail。
    onError: (error) => {
      notify({
        level: 'warn',
        source: 'agent.switch',
        title: t('agent.switchFailed'),
        body: error.message,
        detail: error.message,
      })
    },
  },
)

/* ── store:只剩两格状态与四个 action ───────────────────────────────────── */

/** 模块级的启动闸 —— 「这一个进程启动过没有」不是可渲染状态。 */
let started = false

export const useAgentsSource = create<AgentsSourceState>()((set, get) => ({
  pendingAgentId: null,
  optimistic: {},

  start: async () => {
    if (started) return
    started = true
    const port = await agentsPort()
    await port.ready()
    await agentsQuery.ensure()
  },

  refresh: async () => {
    await agentsQuery.refetch()
  },

  switchAgent: async (sessionId, agentId) => {
    if (!agentId) return
    // 还没进会话:这次选择是「下一条新会话归谁」,不写盘也不发请求。
    if (!sessionId) {
      set({ pendingAgentId: agentId })
      return
    }
    // 同一条会话上已经有一发在飞:这一下不发第二发(律③的另一半 —— 反馈是
    // 「不可再点」,判据与徽上那个 aria-busy 读的是同一格)。
    if (agentMutation.isPending(switchKey(sessionId))) return
    await agentMutation.run({ kind: 'switch', sessionId, agentId })
    // 成败都等这一口:失败时 reconcile 还是上一次那个(或 undefined),等它无害。
    await reconcile
  },

  applyPendingAgent: async (sessionId) => {
    const agentId = get().pendingAgentId
    if (!sessionId || !agentId) return
    // 清空是**无条件**的,而且在写之前:这一格说的是「下一条新会话归谁」,
    // 下一条已经建出来了,这句话就用掉了(理由见接口上那段)。
    set({ pendingAgentId: null })
    // run 不抛 —— 失败已经在原语里处理完了(这一路没有牌可回滚,只剩 notify)。
    await agentMutation.run({ kind: 'apply', sessionId, agentId })
  },

  reset: () => {
    started = false
    reconcile = undefined
    agentsQuery.reset()
    agentMutation.reset()
    set({ pendingAgentId: null, optimistic: {} })
  },
}))

/**
 * **HMR 退役**(09-01 立法,起因是 chat-source 那一案:热更之后旧模块的模块级
 * 副作用没死,两个实例同时活着)。
 *
 * 这个文件的模块级副作用有四样:启动闸 `started`、对账把手 `reconcile`、
 * 名册 query(自带监听表)、写路 mutation(自带监听表与逐格计数)。四样的寿命
 * 都是「这个模块实例」—— 不退役,旧实例的监听表会攥着已卸载组件的回调。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`reset()`),不写第二套。它自身幂等;
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useAgentsSource.getState().reset()
  })
}

/* ── 组件侧 ────────────────────────────────────────────────────────────── */

/**
 * 名册**全集**(含 service 与墓碑)—— 菜单只画 `rosterOf()` 筛出来的那些。
 *
 * 读法与 `providers` 那一路的 `useQuery(catalogQuery.get(pid))` 同源(K1 立的样板),
 * 只多做一件属于这块面的事:拉不到时 `data` 是 undefined,这里兜成**恒等的那张
 * 空表** —— 空名册在屏幕上是一句诚实的「名册不可用」,而恒等引用让照它 memo 的
 * 下游不白重渲(律④)。
 *
 * 回的这个对象字面量每次渲染都是新的,**但它的身份不外流**:唯一的调用点
 * (`AgentChip`)当场解构成两格,谁也没拿它当依赖。所以不为它补一个 `useMemo`。
 */
export function useAgentRoster(): { agents: readonly AgentOption[]; inflight: boolean } {
  const snapshot = useQuery(agentsQuery)
  return { agents: snapshot.data ?? NO_AGENTS, inflight: snapshot.inflight }
}
