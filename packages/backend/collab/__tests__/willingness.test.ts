import { describe, expect, it } from 'vitest'
import {
  COLLAB_WILLINGNESS_LINE_LIMIT,
  COLLAB_WILLINGNESS_PM_FACT,
  buildWillingnessPrompt,
  buildWillingnessWindow,
  parseWillingnessReply,
} from '../willingness.js'
import {
  COLLAB_SYSTEM_SOURCE_MEMBERSHIP,
  COLLAB_SYSTEM_SOURCE_TASK,
} from '../system-lines.js'
import type { CollabAgentLike, CollabMessageLike } from '../types.js'

const AGENTS: CollabAgentLike[] = [
  { id: 'pm', name: '阿明', title: '产品经理' },
  { id: 'fe', name: '小李', title: '前端工程师' },
  { id: 'research', name: '小研', title: '研究员' },
]

const PERSONA = '你是小李,前端工程师。口头禅是"从实现角度讲"。'

const TRANSCRIPT: CollabMessageLike[] = [
  { role: 'user', content: '官网改版,本周上线' },
  { role: 'user', content: '(阿明 · 被 @ 激活)', source: 'collab', origin: { source: 'collab' } },
  { role: 'assistant', content: '收到,我来拆解', agentId: 'pm' },
  { role: 'assistant', content: '[pass]', agentId: 'research' },
  { role: 'system', content: '房间已全部暂停' },
  { role: 'assistant', content: '从实现角度讲,一周可行', agentId: 'fe' },
  { role: 'user', content: '这个项目该用什么技术栈?' },
]

describe('buildWillingnessWindow', () => {
  it('projects IM-style lines and drops drives, pass turns and unmarked system lines', () => {
    const lines = buildWillingnessWindow({ recent: TRANSCRIPT, members: AGENTS })
    expect(lines).toEqual([
      '用户: 官网改版,本周上线',
      '阿明#pm: 收到,我来拆解',
      '小李#fe: 从实现角度讲,一周可行',
      '用户: 这个项目该用什么技术栈?',
    ])
  })

  it('admits marked collab system lines — same rule as the room projection (W9.1)', () => {
    const lines = buildWillingnessWindow({
      recent: [
        { role: 'system', content: '「加 notes.txt」→ 小李\n开始执行', source: COLLAB_SYSTEM_SOURCE_TASK },
        { role: 'system', content: '「加 notes.txt」排队等待执行(并发上限)', source: 'collab' },
        { role: 'system', content: '小研 加入了群聊', source: COLLAB_SYSTEM_SOURCE_MEMBERSHIP },
        { role: 'assistant', content: '已交付', agentId: 'fe' },
      ],
      members: AGENTS,
    })
    expect(lines).toEqual([
      '系统: 「加 notes.txt」→ 小李 开始执行',
      '系统: 小研 加入了群聊',
      '小李#fe: 已交付',
    ])
  })

  it('keeps only the tail window and truncates long messages', () => {
    const many: CollabMessageLike[] = Array.from({ length: 12 }, (_, index) => ({
      role: 'user',
      content: `第${index}条`,
    }))
    const lines = buildWillingnessWindow({ recent: many, members: AGENTS })
    expect(lines).toHaveLength(8)
    expect(lines[0]).toBe('用户: 第4条')

    const [long] = buildWillingnessWindow({
      recent: [{ role: 'user', content: 'x'.repeat(500) }],
      members: AGENTS,
    })
    expect(long.length).toBe('用户: '.length + COLLAB_WILLINGNESS_LINE_LIMIT + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  it('collapses newlines so one message stays one line, and never signs with a raw id', () => {
    const lines = buildWillingnessWindow({
      recent: [
        { role: 'assistant', content: '第一行\n第二行', agentId: 'fe' },
        { role: 'assistant', content: '你好', agentId: 'ghost' },
      ],
      members: AGENTS,
    })
    // P2-16: a speaker the roster no longer holds is 「前成员」, not `ghost` —
    // the judgement window is prompt text, and an id in it is a riddle.
    expect(lines).toEqual(['小李#fe: 第一行 第二行', '前成员#ghost: 你好'])
  })

  it('names a departed member when the global lookup still knows it (P2-16)', () => {
    const lines = buildWillingnessWindow({
      recent: [{ role: 'assistant', content: '你好', agentId: 'ghost' }],
      members: AGENTS,
      resolveAgentName: id => (id === 'ghost' ? '老王' : undefined),
    })
    expect(lines).toEqual(['老王#ghost: 你好'])
  })

  it('carries a quote reply into the judgement window as one entry (W7 §3.5 A)', () => {
    // The quote is the social signal that a message is aimed at somebody —
    // the judge cannot weigh it if it never reaches the window. It rides
    // INSIDE the entry so the window stays limited by messages, not by lines.
    const many: CollabMessageLike[] = Array.from({ length: 8 }, (_, index) => ({
      role: 'user',
      content: `第${index}条`,
    }))
    const lines = buildWillingnessWindow({
      recent: [
        ...many,
        {
          role: 'user',
          content: '这条按你说的做',
          replyTo: { messageId: 'm1', authorLabel: '小李', excerpt: '先做接口再做页面' },
        },
      ],
      members: AGENTS,
    })
    expect(lines).toHaveLength(8)
    expect(lines[7]).toBe('> 小李: 先做接口再做页面\n用户: 这条按你说的做')
  })

  // W13.2: quotes now appear on agent replies too (hung after the fact), and
  // 「谁在回谁」is precisely the judgement signal — a window that only quoted
  // the user's own messages would hide half of it.
  it('carries a quote hung on an agent reply (W13.2 补挂)', () => {
    const lines = buildWillingnessWindow({
      recent: [{
        role: 'assistant',
        agentId: 'fe',
        content: '明天下班前',
        replyTo: { messageId: 'm1', authorLabel: '用户', excerpt: '登录页什么时候能好?' },
      }],
      members: AGENTS,
    })
    expect(lines).toEqual(['> 用户: 登录页什么时候能好?\n小李#fe: 明天下班前'])
  })

  it('carries the reaction tally, same source as the projection (W8 §3.5 B)', () => {
    // 「群里已经三个人点了赞」is exactly the signal that says nobody needs to
    // say it again — a judgement blind to it is judging a different room.
    const lines = buildWillingnessWindow({
      recent: [
        {
          role: 'user',
          content: '上线了',
          reactions: [{ emoji: '🎉', by: [{ type: 'agent', agentId: 'fe' }, { type: 'agent', agentId: 'pm' }] }],
        },
      ],
      members: AGENTS,
    })
    expect(lines).toEqual(['用户: 上线了 (🎉×2)'])
  })

  it('leaves an unreacted message byte-identical', () => {
    expect(buildWillingnessWindow({
      recent: [{ role: 'user', content: '上线了', reactions: [] }],
      members: AGENTS,
    })).toEqual(['用户: 上线了'])
  })
})

describe('buildWillingnessPrompt', () => {
  const base = {
    self: AGENTS[1],
    members: AGENTS,
    roomName: '官网改版项目组',
    personaPrompt: PERSONA,
    recent: TRANSCRIPT,
  }

  it('is the persona VERBATIM plus the factual room note — no behavioral rules', () => {
    const { system } = buildWillingnessPrompt(base)
    expect(system.startsWith(PERSONA)).toBe(true)
    expect(system).toContain('<where_you_are>')
    expect(system).toContain('「官网改版项目组」')
    expect(system).not.toContain('<rules>')
    expect(system).not.toContain('扮演')
    expect(system).not.toContain('铁律')
    // The JSON instruction is the task, and belongs to the user turn only.
    expect(system).not.toContain('respond')
  })

  /**
   * 判定薄档(collab-turn-protocol-and-identity.md D.1)。判定是一次**零工具**的
   * 裸 generate:`<your_tools>`、变量板、`<board>` 三段对它而言字字是假话 ——
   * 它此刻手上一个工具都没有,却被告知"重活立卡、变量板随时可读"。
   */
  it('薄档:判定的 system 里没有工具面、变量板与看板段', () => {
    const { system } = buildWillingnessPrompt(base)
    expect(system).not.toContain('<your_tools>')
    expect(system).not.toContain('<board>')
    expect(system).not.toContain('context-variable board')
    expect(system).not.toContain('`board` tool')
    // 场子、花名册、发送机制仍在:判定要知道自己在哪、有谁、开口意味着什么。
    expect(system).toContain('<where_you_are>')
    expect(system).toContain('<room name="官网改版项目组">')
    expect(system).toContain('<messaging>')
  })

  /**
   * 房形态跟着调用方走(D.1 后半)。pair 房用群版世界观会把用户说成"群成员",
   * 判定于是站在一个错误的场子里回答"要不要开口"。
   */
  it('按房形态换情况说明:pair 房的判定读的是私聊那一版', () => {
    const pair = buildWillingnessPrompt({ ...base, dmPair: true }).system
    expect(pair).toContain('A private chat between the two of you')
    expect(pair).not.toContain('<room name=')
    const dm = buildWillingnessPrompt({ ...base, dm: true }).system
    expect(dm).toContain('A one-on-one conversation')
  })

  it('adds the lead fact for the PM only', () => {
    expect(buildWillingnessPrompt({ ...base, pmAgentId: 'pm' }).system)
      .not.toContain(COLLAB_WILLINGNESS_PM_FACT)
    expect(buildWillingnessPrompt({ ...base, self: AGENTS[0], personaPrompt: '你是阿明。', pmAgentId: 'pm' }).system)
      .toContain(COLLAB_WILLINGNESS_PM_FACT)
    expect(buildWillingnessPrompt({ ...base, pmAgentId: 'fe' }).system)
      .toContain(COLLAB_WILLINGNESS_PM_FACT)
  })

  /**
   * 判定走裸 `generateChatResponse`,够不着变量通道 —— 房间回合那侧的
   * `my_cards` 一格都到不了这里。所以卡必须由调用方喂进来,否则「任务受阻」
   * 这类最该让人开口的事实,恰好在决定要不要开口的那一刻看不见。
   *
   * 这条是 agent-self-state-variables.md §4.4 删 taskFacts 时漏掉的一条链,
   * 钉在这里免得下次又被顺手删掉。
   */
  it('把在飞的卡带进判定 —— 判定看见的事实与它作答时会看见的同一批', () => {
    const cards = [
      { id: 'ffffeeee-2222', title: '重构配置读取', status: 'blocked' as const },
      { id: 'a1b2c3d4-1111', title: '登录页改版', status: 'doing' as const },
    ]
    const { system } = buildWillingnessPrompt({ ...base, selfCards: cards })
    // 形状与 `my_cards` 变量逐字同源;按 id 排序,同一组卡永远同样的字节。
    expect(system).toContain(
      '<your_cards>#a1b2c3d4「登录页改版」doing; #ffffeeee「重构配置读取」blocked</your_cards>',
    )
    // 没有卡就一个字都不说 —— 一块空板子不值一行 prompt。
    expect(buildWillingnessPrompt(base).system).not.toContain('<your_cards>')
  })

  it('asks the JSON question after the window, newest message last', () => {
    const { user } = buildWillingnessPrompt(base)
    const lines = user.split('\n').filter(Boolean)
    expect(lines[0]).toBe('用户: 官网改版,本周上线')
    // 窗口在前、问句在后 —— 最后一条房间消息紧挨着问句的第一行。
    const questionStart = lines.indexOf('After that last message, will you speak up?')
    expect(questionStart).toBeGreaterThan(0)
    expect(lines[questionStart - 1]).toBe('用户: 这个项目该用什么技术栈?')
    expect(user).toContain('{"respond": true|false, "react": "👍"|null}')
    expect(user).not.toContain('[pass]')
    expect(user).not.toContain('被 @ 激活')
  })

  /**
   * W9.3 的 `<your_cards>` 已退役(agent-self-state-variables.md §4.4)。判定这
   * 一路**不走引擎的提示词装配**(它是一次裸的 generateChatResponse),所以变量
   * 通道到不了这里 —— 判定从此看不到自己的在飞卡片,这是本次迁移的已知代价。
   */
  it('no longer carries a hand-written cards block', () => {
    expect(buildWillingnessPrompt(base).system).not.toContain('<your_cards>')
  })

  it('still asks the question when the window is empty', () => {
    const { user } = buildWillingnessPrompt({ ...base, recent: [] })
    expect(user.startsWith('After that last message, will you speak up?')).toBe(true)
  })
})

describe('parseWillingnessReply', () => {
  /** The `respond` half only — every assertion below predates W8 and must
   *  keep reading exactly the same through the structured return. */
  const respondOf = (text: string | null | undefined) => parseWillingnessReply(text).respond

  it('reads the standard answer in both directions', () => {
    expect(respondOf('{"respond": true}')).toBe(true)
    expect(respondOf('{"respond": false}')).toBe(false)
    expect(respondOf("{'respond':TRUE}")).toBe(true)
  })

  it('tolerates markdown fences and surrounding prose', () => {
    expect(respondOf('```json\n{"respond": true}\n```')).toBe(true)
    expect(respondOf('好的,我的判断是:\n```\n{ "respond" : true }\n```\n(以上)')).toBe(true)
    expect(respondOf('```json\n{"respond": false}\n```')).toBe(false)
  })

  it('accepts a bare boolean but nothing looser', () => {
    expect(respondOf('true')).toBe(true)
    expect(respondOf(' "TRUE" ')).toBe(true)
    expect(respondOf('我觉得 true 应该说两句')).toBe(false)
  })

  it('is false for empty, garbage, and echoed instructions', () => {
    expect(respondOf('')).toBe(false)
    expect(respondOf(undefined)).toBe(false)
    expect(respondOf(null)).toBe(false)
    expect(respondOf('我会说话的')).toBe(false)
    expect(respondOf('{"speak": true}')).toBe(false)
    // Echoing the instruction is not an answer.
    expect(respondOf('只输出 JSON: {"respond": true|false}')).toBe(false)
  })

  // ── W8: the react half (§3.5 B) ──

  it('carries no reaction for the pre-W8 shape (backward compatible)', () => {
    expect(parseWillingnessReply('{"respond": false}'))
      .toEqual({ respond: false, react: null, outcome: 'no' })
    expect(parseWillingnessReply('{"respond": true}'))
      .toEqual({ respond: true, react: null, outcome: 'yes' })
    expect(parseWillingnessReply('true')).toEqual({ respond: true, react: null, outcome: 'yes' })
  })

  it('reads a palette emoji alongside the verdict', () => {
    expect(parseWillingnessReply('{"respond": false, "react": "👍"}'))
      .toEqual({ respond: false, react: '👍', outcome: 'no' })
    expect(parseWillingnessReply('```json\n{"respond": false, "react": "🎉"}\n```'))
      .toEqual({ respond: false, react: '🎉', outcome: 'no' })
    // Unquoted and single-quoted forms are the same answer.
    expect(parseWillingnessReply("{'respond': false, 'react': '👀'}").react).toBe('👀')
    expect(parseWillingnessReply('{"respond": false, "react": 🤔}').react).toBe('🤔')
  })

  it('canonicalizes an emoji written without its variation selector', () => {
    // Models drop U+FE0F freely; '❤' and '❤️' are the same reaction.
    expect(parseWillingnessReply('{"respond": false, "react": "❤"}').react).toBe('❤️')
  })

  it('drops anything outside the palette', () => {
    expect(parseWillingnessReply('{"respond": false, "react": "🚀"}').react).toBeNull()
    expect(parseWillingnessReply('{"respond": false, "react": "赞"}').react).toBeNull()
    expect(parseWillingnessReply('{"respond": false, "react": null}').react).toBeNull()
    expect(parseWillingnessReply('{"respond": false, "react": ""}').react).toBeNull()
  })

  it('does not read an echoed react instruction as a real reaction', () => {
    expect(parseWillingnessReply('只输出 JSON: {"respond": true|false, "react": "👍"|null}'))
      .toEqual({ respond: false, react: null, outcome: 'unparsable' })
  })
})

/**
 * §8:`respond:false` 此前是五种完全不同的事共用的一个答案。解析器这一层能分开
 * 的是其中两种 —— 「模型明确说了不」和「回复读不懂」；另外三种(超时/没发出去/
 * 被打断)在 runner 那一层判。
 */
describe('parseWillingnessReply — 成因', () => {
  it('明确的 true/false 是 yes/no', () => {
    expect(parseWillingnessReply('{"respond": true}').outcome).toBe('yes')
    expect(parseWillingnessReply('{"respond": false}').outcome).toBe('no')
  })

  it('裸 true / 裸 false 也算答过了 —— 没按 JSON 但意思明确', () => {
    expect(parseWillingnessReply('true').outcome).toBe('yes')
    expect(parseWillingnessReply('false').outcome).toBe('no')
    expect(parseWillingnessReply('「false」。').outcome).toBe('no')
  })

  it('**回复有内容却读不出结论 = unparsable,不是 no**', () => {
    // 推理模型把 64 token 预算烧在思考上就是这个形状 —— 满屋子 unparsable 指向
    // prompt 或模型,而满屋子 no 指向"这群人真的没话说",两者的处置完全不同。
    expect(parseWillingnessReply('我觉得这个话题我不太合适').outcome).toBe('unparsable')
    expect(parseWillingnessReply('{"speak": "maybe"}').outcome).toBe('unparsable')
  })

  it('回声(把指令原样抄回来)不算答过', () => {
    expect(parseWillingnessReply('{"respond": true|false}').outcome).toBe('unparsable')
  })

  it('空回复 = unparsable(runner 会按超时/中止覆写成更准的那个)', () => {
    expect(parseWillingnessReply('').outcome).toBe('unparsable')
    expect(parseWillingnessReply(null).outcome).toBe('unparsable')
  })
})
