import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { DEFAULT_AGENT_ID } from '@shared/ipc/agents'
import { ChevronDown } from './icons'
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu'
import { useAgentMenu } from './agent-menu'
import {
  findAgentOption,
  resolveAgentId,
  rosterOf,
  useAgentsSource,
  type AgentOption,
} from '../data/agents-source'
import { useSessionsSource } from '../data/sessions-source'
import { findSession } from '../expose/projection'
import { useExposeStore } from '../expose/store'
import { useT } from '../i18n'
import s from './AgentChip.module.css'

/**
 * 顶栏右侧那枚**安静的徽**:这条会话现在归谁。
 *
 * 它站的是原来那枚模型章的位子 —— 模型选择已经在 composer 上了,顶栏再放一枚
 * 是同一件事说两遍(08-30 拍板:模型章退役,原位换 agent)。
 *
 * ── 切换的语义(已收敛,不由这一层解释) ────────────────────────────────
 *  · 有会话:改这条会话的 agentId,**从下一条消息起生效,历史照留**。
 *    这是后端 `sessions.updateAgent` 的既有行为,不是这里加的说法。
 *  · 没有会话:这次选择是「下一条新会话归谁」。它今天只到内存为止 ——
 *    新壳自己不建会话,后端的建会话请求也没有 agentId 这一格(见 agents-source
 *    的 `pendingAgentId` 留账)。所以徽上会立刻换脸,但**没有第二件事发生**。
 *
 * ── 换人不记档 ─────────────────────────────────────────────────────────
 * 消息流里**不**插「已切换到 X」的小灰字:账本里没有这件事的产地
 * (`events.jsonl` 没有 agent-changed 这一类),UI 自己编一条出来就是在
 * 屏幕上造事实。留账,等产地。
 *
 * ── 头像的色从哪来 ─────────────────────────────────────────────────────
 * 名册给了 color 就用它(经 `--agent-color` 递进 CSS,配方在 css 里);
 * 没给就按 id 哈希在六对固定渐变里挑一对 —— 同一个人每次开都是同一张脸。
 * agent 自定义色的**编辑面**是后续,这一批只消费名册已有的那一格。
 */

/** 渐变对的条数。与 AgentChip.module.css 的 .grad0…5 一一对应,改一处必须改两处。 */
const GRADIENT_COUNT = 6

/** 名字/emoji 都没有时,头像里那个字取谁 —— 只取第一个字素,不做任何缩写规则。 */
function initialOf(name: string): string {
  return [...name][0] ?? ''
}

/**
 * id → 第几对渐变。FNV-1a 的一小截:要的只是「同一个 id 永远同一张脸」,
 * 不是散列质量。**不用 name** —— 改个名字不该换一张脸。
 */
export function gradientIndexOf(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % GRADIENT_COUNT
}

interface AvatarProps {
  agent: AgentOption | undefined
  /** 名册里查不到时画什么名字(默认助手 / 未知 id 都走它)。 */
  fallbackName: string
  size: 'chip' | 'row'
}

function AgentAvatar({ agent, fallbackName, size }: AvatarProps) {
  const id = agent?.id ?? DEFAULT_AGENT_ID
  const name = agent?.name || fallbackName
  // color 是**数据**(某个 agent 自己的颜色),不是写在组件里的字面色值:
  // 递进去一个自定义属性,配色公式在 css 里。两条脸的路**互斥**,二选一 ——
  // 靠特异性去压另一条的写法在 CSS 里迟早会被谁不小心翻掉。
  const custom = agent?.color ?? null
  const cls = [
    s.avatar,
    size === 'row' ? s.avatarRow : s.avatarChip,
    custom ? s.avatarCustom : s[`grad${gradientIndexOf(id)}`],
  ]
    .filter(Boolean)
    .join(' ')
  const style = custom ? ({ ['--agent-color']: custom } as CSSProperties) : undefined
  return (
    <span className={cls} style={style} aria-hidden="true">
      {agent?.avatar ?? initialOf(name)}
    </span>
  )
}

interface RowProps {
  agent: AgentOption | undefined
  name: string
  description: string | null
  fallbackName: string
}

/** 名册行:26 头像 + 名 + 一句描述。描述缺席就不画那一行(不占高)。 */
function AgentRow({ agent, name, description, fallbackName }: RowProps) {
  return (
    <span className={s.row}>
      <AgentAvatar agent={agent} fallbackName={fallbackName} size="row" />
      <span className={s.rowText}>
        <span className={s.rowName}>{name}</span>
        {description && <span className={s.rowDesc}>{description}</span>}
      </span>
    </span>
  )
}

export function AgentChip() {
  const t = useT()
  const ref = useRef<HTMLButtonElement>(null)

  const open = useAgentMenu((st) => st.open)
  const setOpen = useAgentMenu((st) => st.setOpen)
  const toggle = useAgentMenu((st) => st.toggle)

  const agents = useAgentsSource((st) => st.agents)
  const status = useAgentsSource((st) => st.status)
  const optimistic = useAgentsSource((st) => st.optimistic)
  const pendingAgentId = useAgentsSource((st) => st.pendingAgentId)
  const switchAgent = useAgentsSource((st) => st.switchAgent)

  const currentSessionId = useExposeStore((st) => st.currentSessionId)
  const sessions = useSessionsSource((st) => st.sessions)
  const session = findSession(sessions, currentSessionId)

  // 没有会话时,徽上显示的是「下一条新会话归谁」;有会话时是这条会话的事实。
  const activeId = session
    ? resolveAgentId(optimistic, session.id, session.agentId)
    : (pendingAgentId ?? DEFAULT_AGENT_ID)
  const active = findAgentOption(agents, activeId)
  const defaultName = t('agent.default')
  const defaultAgent = findAgentOption(agents, DEFAULT_AGENT_ID)
  /**
   * 默认助手那一行的名字**永远是界面文案**,不取名册那份。
   *
   * 判据是 i18n 的那一条(见 src/i18n/index.ts 顶部):换一门语言,它该不该跟着变?
   * 该 —— 它不是谁给自己起的名字,它是「没有选择」这件事的说法。真机实测
   * (08-30,全新 store)后端出厂给的就是英文的 `Default Agent`,照搬进来
   * 会让中文界面上凭空冒出一句英文。
   *
   * 代价记在这里:用户若把默认 agent 改了名,顶栏不会显示那个名字。
   * 出现「改默认 agent 的名字」这条真需求时再谈,今天不为它牺牲可本地化。
   * 头像 / 描述照旧取名册那份 —— 那两格没有语言问题。
   */
  const defaultRowName = defaultName
  // 徽上写谁:默认助手走界面文案(同上),别人走名册的真名;名册里查不到 ——
  // 比如绑着一个已被硬删的 id —— 也退到默认名,不把一个 id 当名字画上去。
  const activeName =
    activeId === DEFAULT_AGENT_ID ? defaultName : (active?.name || defaultName)
  const roster = rosterOf(agents).filter((a) => a.id !== DEFAULT_AGENT_ID)
  const rosterMissing = roster.length === 0

  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  // 开关是数据,坐标是这一刻的 DOM 事实 —— 所以坐标在这里量,不进 store。
  // 贴着徽的下缘展开;越界由 Menu 自己 clamp(与 ui/Select 同一条判例)。
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const r = ref.current?.getBoundingClientRect()
    setAnchor(r ? { x: r.left, y: r.bottom } : null)
  }, [open])

  const pick = (agentId: string) => {
    setOpen(false)
    void switchAgent(session?.id ?? null, agentId)
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={s.chip}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('agent.menuLabel')}
        // 与 ui/Select 同一条:不拦住这一下,再点一次徽会先关再开,看着像没反应。
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggle}
      >
        <AgentAvatar agent={active} fallbackName={activeName} size="chip" />
        <span className={s.name}>{activeName}</span>
        <ChevronDown className={s.chevron} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {anchor && (
        <Menu x={anchor.x} y={anchor.y} onClose={() => setOpen(false)} label={t('agent.menuLabel')}>
          <div className={s.menu}>
            {/* 默认助手永远在册:它不是一条名册记录,是「没有选择」本身。 */}
            <MenuItem
              checked={activeId === DEFAULT_AGENT_ID}
              onClick={() => pick(DEFAULT_AGENT_ID)}
            >
              <AgentRow
                agent={defaultAgent}
                name={defaultRowName}
                description={defaultAgent?.description ?? null}
                fallbackName={defaultName}
              />
            </MenuItem>

            {roster.map((agent) => (
              <MenuItem key={agent.id} checked={activeId === agent.id} onClick={() => pick(agent.id)}>
                <AgentRow
                  agent={agent}
                  name={agent.name}
                  description={agent.description}
                  fallbackName={defaultName}
                />
              </MenuItem>
            ))}

            {/* 拉不到名册就说拉不到 —— 不拿一个空列表冒充「你只有默认助手」。 */}
            {rosterMissing && status !== 'loading' && (
              <div className={s.unavailable}>{t('agent.rosterUnavailable')}</div>
            )}

            <MenuSeparator />

            {/*
              管理页不在本批。渲染但**不可点** —— 画一个点了没反应的入口比不画更糟,
              所以它是 disabled 而不是一个 noop:手感上当场说清「这里还没通」。
            */}
            <button type="button" className={s.manage} role="menuitem" disabled>
              {t('agent.manage')}
            </button>
          </div>
        </Menu>
      )}
    </>
  )
}
