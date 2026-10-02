import { describe, expect, it } from 'vitest'
import {
  COLLAB_DRIVE_LABEL_TASK_HALTED,
  COLLAB_DRIVE_LABEL_TASK_REVIEW,
  decideCollabActivations,
  formatCollabActivationLabel,
} from '../activation.js'
import { computeCollabChainCount, collabMessageCountsTowardChain, collabMessageResetsChain } from '../chain.js'
import { parseCollabMentions } from '../mentions.js'
import { isCollabPassMessage } from '../pass.js'
import { formatCollabReplyQuote, projectRoomHistory } from '../projection.js'
import {
  buildCollabRoomContext,
  buildCollabRoomSystemPrompt,
} from '../roster.js'
import {
  COLLAB_HALT_REASON_EXCERPT_CHARS,
  COLLAB_NO_EVIDENCE_TEXT,
  COLLAB_SYSTEM_SOURCE_MEMBERSHIP,
  COLLAB_SYSTEM_SOURCE_TASK,
  COLLAB_TASK_HALTED_DISPOSITION,
  buildCollabMembershipLines,
  buildCollabTaskDeliveredLine,
  buildCollabTaskDoneLine,
  buildCollabTaskHaltCapLine,
  buildCollabTaskHaltedLine,
  buildCollabTaskRequeueRefusedLine,
  formatCollabTaskEvidence,
  isCollabProjectedSystemLine,
} from '../system-lines.js'
import {
  COLLAB_HARVEST_SOURCE,
  isCollabDriveMessage,
  isCollabHarvestMessage,
  type CollabAgentLike,
  type CollabMessageLike,
} from '../types.js'

const AGENTS: CollabAgentLike[] = [
  { id: 'pm', name: '阿明', title: '产品经理', description: '拆解目标、分派任务' },
  { id: 'fe', name: '小李', title: '前端工程师' },
  { id: 'research', name: '小研', title: '研究员' },
]

describe('parseCollabMentions', () => {
  it('matches CJK names after @ in appearance order, deduped', () => {
    expect(parseCollabMentions('@小研 你看下,@阿明 拍板,@小研 再补充', AGENTS)).toEqual(['research', 'pm'])
  })

  it('prefers the longest name at the same @ position', () => {
    const members: CollabAgentLike[] = [
      { id: 'a', name: '小李' },
      { id: 'b', name: '小李工' },
    ]
    expect(parseCollabMentions('@小李工 上', members)).toEqual(['b'])
  })

  it('ignores text without mentions and unknown names', () => {
    expect(parseCollabMentions('大家好', AGENTS)).toEqual([])
    expect(parseCollabMentions('@路人甲 你好', AGENTS)).toEqual([])
    expect(parseCollabMentions(undefined, AGENTS)).toEqual([])
  })
})

describe('isCollabPassMessage', () => {
  it('accepts the bare sentinel with whitespace tolerance', () => {
    expect(isCollabPassMessage('[pass]')).toBe(true)
    expect(isCollabPassMessage('  [PASS]  \n')).toBe(true)
  })

  it('treats hedged multi-line output as normal speech', () => {
    expect(isCollabPassMessage('[pass]\n但是我想补充一点')).toBe(false)
    expect(isCollabPassMessage('我 pass')).toBe(false)
    expect(isCollabPassMessage('')).toBe(false)
  })
})

describe('isCollabDriveMessage', () => {
  it('detects drives by source or origin.source', () => {
    expect(isCollabDriveMessage({ role: 'user', source: 'collab' })).toBe(true)
    expect(isCollabDriveMessage({ role: 'user', origin: { source: 'collab' } })).toBe(true)
    expect(isCollabDriveMessage({ role: 'user', source: 'text' })).toBe(false)
    expect(isCollabDriveMessage({ role: 'assistant', source: 'collab' })).toBe(false)
  })
})

describe('projectRoomHistory', () => {
  const transcript: CollabMessageLike[] = [
    { role: 'user', content: '@阿明 官网改版,本周上线' },
    { role: 'user', content: '(激活:mention)', source: 'collab', origin: { source: 'collab' } },
    { role: 'assistant', content: '收到,拆解如下', agentId: 'pm', toolCalls: [{ name: 'board', arguments: { action: 'create' }, result: 'ok' }] },
    { role: 'assistant', content: '[pass]', agentId: 'research' },
    { role: 'assistant', content: '从实现角度讲,一周可行', agentId: 'fe' },
    { role: 'user', content: '@小李 工时压几天?' },
  ]

  /**
   * collab-chatroom-payload.md:整间房是**一条 user 消息**,房间侧一个 assistant
   * 轮都没有 —— 旧形状(别人是 user 轮、自己是 assistant 轮)在教模型「你正在
   * 对话,你的输出就是你的回复」,而它在后台会话里,只有 say 出得去。
   */
  it('把整间房塌成一条 user 消息:结构里没有「该你接话」的槽位', () => {
    const projected = projectRoomHistory({
      messages: transcript,
      selfAgentId: 'fe',
      agents: AGENTS,
      roomName: '官网改版项目组',
    })
    expect(projected).toEqual([{
      role: 'user',
      content: [
        '<ChatRoom name="官网改版项目组">',
        '<Members>',
        // Members 含自己并标 self —— 它是模型认出 History 里哪几条是自己说的
        // 唯一线索。名字/句柄/职位各占一个属性,模型不必从一行文本里剥。
        '<Member name="用户" role="用户"/>',
        '<Member name="阿明" handle="pm" role="产品经理" description="拆解目标、分派任务"/>',
        '<Member name="小李" handle="fe" role="前端工程师" self="true"/>',
        '<Member name="小研" handle="research" role="研究员"/>',
        '</Members>',
        '<History>',
        '<message from="用户">@阿明 官网改版,本周上线</message>',
        '<message from="阿明#pm">收到,拆解如下\n〔调用 board({"action":"create"}) → ok〕</message>',
        // 自己的发言也在 History 里,署名自己的「名字#句柄」,正文逐字原样。
        '<message from="小李#fe">从实现角度讲,一周可行</message>',
        '<message from="用户">@小李 工时压几天?</message>',
        '</History>',
        '</ChatRoom>',
      ].join('\n'),
    }])
  })

  it('房间侧永远没有 assistant 轮,换谁看都一样', () => {
    for (const selfAgentId of ['fe', 'pm', 'research']) {
      const projected = projectRoomHistory({ messages: transcript, selfAgentId, agents: AGENTS })
      expect(projected).toHaveLength(1)
      expect(projected[0].role).toBe('user')
    }
  })

  it('房名进 name 属性,没房名就不编一个出来', () => {
    const unnamed = projectRoomHistory({ messages: transcript, selfAgentId: 'fe', agents: AGENTS })
    expect(unnamed[0].content.startsWith('<ChatRoom>\n')).toBe(true)
    const named = projectRoomHistory({
      messages: transcript,
      selfAgentId: 'fe',
      agents: AGENTS,
      roomName: '小"李"的房',
    })
    // 房名同样来自代码而非模型,但引号照样转义 —— 撑破标签的代价是整块读错。
    expect(named[0].content.startsWith('<ChatRoom name="小&quot;李&quot;的房">')).toBe(true)
  })

  it('用户行与同事行同形:传了身份就是「名字#句柄」', () => {
    const projected = projectRoomHistory({
      messages: [{ role: 'user', content: '在吗' }],
      selfAgentId: 'fe',
      agents: AGENTS,
      userLabel: '一天',
      userHandle: 'yitian',
    })
    // 名单里 role="用户" 占「职位」那一格,信封里是可照抄进 `dm to:` 的裸 token。
    expect(projected[0].content).toContain('<Member name="一天" handle="yitian" role="用户"/>')
    expect(projected[0].content).toContain('<message from="一天#yitian">在吗</message>')
  })

  it('excludes drives and pass turns from every projection', () => {
    const projected = projectRoomHistory({ messages: transcript, selfAgentId: 'pm', agents: AGENTS })
    const all = projected.map(entry => entry.content).join('\n')
    expect(all).not.toContain('激活:mention')
    expect(all).not.toContain('[pass]')
  })

  it('每个人的发言都在同一块 History 里,一条消息一个信封', () => {
    const projected = projectRoomHistory({ messages: transcript, selfAgentId: 'research', agents: AGENTS })
    expect(projected).toHaveLength(1)
    expect(projected[0].role).toBe('user')
    expect(projected[0].content).toContain('<message from="阿明#pm">')
    expect(projected[0].content).toContain('<message from="小李#fe">')
  })

  it('never signs a line with a raw id, and labels known agents by bare name', () => {
    // P2-16: the roster is the room's CURRENT members, so a departed member
    // misses it — and `agent-a1b2…: 你好` in a prompt invites the model to guess
    // whether that is a person. A global lookup answers first; failing that,
    // the honest word.
    const projected = projectRoomHistory({
      messages: [{ role: 'assistant', content: '你好', agentId: 'ghost' }],
      selfAgentId: 'fe',
      agents: [{ id: 'other', name: '无衔' }],
    })
    expect(projected[0].content).toContain('<message from="前成员#ghost">你好</message>')

    const departed = projectRoomHistory({
      messages: [{ role: 'assistant', content: '你好', agentId: 'ghost' }],
      selfAgentId: 'fe',
      agents: [{ id: 'other', name: '无衔' }],
      resolveAgentName: id => (id === 'ghost' ? '老王' : undefined),
    })
    expect(departed[0].content).toContain('<message from="老王#ghost">你好</message>')

    const titleless = projectRoomHistory({
      messages: [{ role: 'assistant', content: '你好', agentId: 'other' }],
      selfAgentId: 'fe',
      agents: [{ id: 'other', name: '无衔' }],
    })
    expect(titleless[0].content).toContain('<message from="无衔#other">你好</message>')
    // 没职位就不写 role —— 空属性是噪声,不补一个 role=""。
    expect(titleless[0].content).toContain('<Member name="无衔" handle="other"/>')
  })
})

describe('projectRoomHistory — quote replies (W7 §3.5 A)', () => {
  it('renders a reply as the IM two-line form: quote above, speech below', () => {
    const projected = projectRoomHistory({
      messages: [{
        role: 'user',
        content: '那就按你说的做',
        replyTo: { messageId: 'm1', authorLabel: '阿明', excerpt: '我建议先做接口再做页面' },
      }],
      selfAgentId: 'fe',
      agents: AGENTS,
    })
    expect(projected[0].content).toContain('<message from="用户">> 阿明: 我建议先做接口再做页面\n那就按你说的做</message>')
  })

  it('quotes an agent reply with the same shape', () => {
    const projected = projectRoomHistory({
      messages: [{
        role: 'assistant',
        agentId: 'fe',
        content: '我来接',
        replyTo: { messageId: 'm1', authorLabel: '用户', excerpt: '谁来做登录页?' },
      }],
      selfAgentId: 'pm',
      agents: AGENTS,
    })
    expect(projected[0].content).toContain('<message from="小李#fe">> 用户: 谁来做登录页?\n我来接</message>')
  })

  it('keeps the quoted context even when the original is no longer in the window', () => {
    // The snapshot travels ON the reply — that is the whole point of copying
    // rather than pointing (§3.5 A).
    const projected = projectRoomHistory({
      messages: [{
        role: 'user',
        content: '同意',
        replyTo: { messageId: 'gone', authorLabel: '小研', excerpt: '数据支持这个方向' },
      }],
      selfAgentId: 'fe',
      agents: AGENTS,
    })
    expect(projected[0].content).toContain('> 小研: 数据支持这个方向')
  })

  it('drops an empty snapshot instead of emitting a bare quote marker', () => {
    const projected = projectRoomHistory({
      messages: [
        { role: 'user', content: '继续', replyTo: { messageId: 'm1', authorLabel: '阿明', excerpt: '  ' } },
      ],
      selfAgentId: 'fe',
      agents: AGENTS,
    })
    expect(projected[0].content).toContain('<message from="用户">继续</message>')
  })

  it('falls back to 成员 when the snapshot carries no author', () => {
    expect(formatCollabReplyQuote({ excerpt: '这条' })).toBe('> 成员: 这条')
    expect(formatCollabReplyQuote(undefined)).toBe('')
  })
})

describe('projectRoomHistory — reactions (W8 §3.5 B)', () => {
  it('tail-annotates a reacted user message with the aggregated tally', () => {
    const projected = projectRoomHistory({
      messages: [{
        role: 'user',
        content: '上线了',
        reactions: [{ emoji: '🎉', by: [{ type: 'agent', agentId: 'fe' }, { type: 'agent', agentId: 'pm' }] }],
      }],
      selfAgentId: 'fe',
      agents: AGENTS,
    })
    expect(projected[0].content).toContain('<message from="用户">上线了 (🎉×2)</message>')
  })

  it('annotates another agent’s speech too, and stacks with the quote line', () => {
    const projected = projectRoomHistory({
      messages: [{
        role: 'assistant',
        agentId: 'fe',
        content: '我来接',
        replyTo: { messageId: 'm1', authorLabel: '用户', excerpt: '谁来做登录页?' },
        reactions: [{ emoji: '👍', by: [{ type: 'user' }] }],
      }],
      selfAgentId: 'pm',
      agents: AGENTS,
    })
    // Quote stays on top; the tally rides the tail of the speech line itself.
    expect(projected[0].content).toContain('<message from="小李#fe">> 用户: 谁来做登录页?\n我来接 (👍)</message>')
  })

  it('never annotates the activated agent’s OWN past speech', () => {
    // Appending words an agent did not write to its own transcript would make
    // it read「(👍)」as something it said. 换了容器,这条铁律没有松动。
    const projected = projectRoomHistory({
      messages: [{
        role: 'assistant',
        agentId: 'fe',
        content: '我来接',
        reactions: [{ emoji: '👍', by: [{ type: 'user' }] }],
      }],
      selfAgentId: 'fe',
      agents: AGENTS,
    })
    expect(projected[0].content).toContain('<message from="小李#fe">我来接</message>')
    expect(projected[0].content).not.toContain('👍')
  })

  it('leaves a message with no reactions byte-identical', () => {
    const projected = projectRoomHistory({
      messages: [
        { role: 'user', content: '继续', reactions: [] },
        { role: 'user', content: '再来', reactions: [{ emoji: '👍', by: [] }] },
      ],
      selfAgentId: 'fe',
      agents: AGENTS,
    })
    expect(projected[0].content).toContain('<message from="用户">继续</message>\n<message from="用户">再来</message>')
  })
})

describe('isCollabProjectedSystemLine (W9.1 放行/拒斥矩阵)', () => {
  it('admits marked task and membership lines, by source or origin.source', () => {
    expect(isCollabProjectedSystemLine({ role: 'system', source: COLLAB_SYSTEM_SOURCE_TASK })).toBe(true)
    expect(isCollabProjectedSystemLine({ role: 'system', source: COLLAB_SYSTEM_SOURCE_MEMBERSHIP })).toBe(true)
    expect(isCollabProjectedSystemLine({ role: 'system', origin: { source: COLLAB_SYSTEM_SOURCE_TASK } })).toBe(true)
  })

  it('rejects operational noise, unmarked system lines and non-system roles', () => {
    // Budget / chain gate / freeze / permission reminders are posted with the
    // plain collab source and must stay display-only.
    expect(isCollabProjectedSystemLine({ role: 'system', source: 'collab' })).toBe(false)
    expect(isCollabProjectedSystemLine({ role: 'system' })).toBe(false)
    expect(isCollabProjectedSystemLine({ role: 'system', source: 'text' })).toBe(false)
    expect(isCollabProjectedSystemLine({ role: 'user', source: COLLAB_SYSTEM_SOURCE_TASK })).toBe(false)
    expect(isCollabProjectedSystemLine({ role: 'assistant', source: COLLAB_SYSTEM_SOURCE_TASK })).toBe(false)
  })
})

describe('projectRoomHistory — collab system lines (W9.1)', () => {
  const transcript: CollabMessageLike[] = [
    { role: 'system', content: '「加 notes.txt」→ 小李 开始执行(看板可查看现场)', source: COLLAB_SYSTEM_SOURCE_TASK },
    { role: 'system', content: '今天这个房间已花费 $5.00,达到日预算 $5', source: 'collab' },
    { role: 'system', content: '「加 notes.txt」受阻:小李 无法继续,任务未交付', source: COLLAB_SYSTEM_SOURCE_TASK },
    { role: 'assistant', content: '已交付,notes.txt 写好了', agentId: 'fe' },
  ]

  it('relays marked task lines as 系统 blocks and drops the operational ones', () => {
    const projected = projectRoomHistory({ messages: transcript, selfAgentId: 'pm', agents: AGENTS })
    expect(projected).toHaveLength(1)
    expect(projected[0].content).toContain([
      '<message from="系统">「加 notes.txt」→ 小李 开始执行(看板可查看现场)</message>',
      '<message from="系统">「加 notes.txt」受阻:小李 无法继续,任务未交付</message>',
      '<message from="小李#fe">已交付,notes.txt 写好了</message>',
    ].join('\n'))
    // The reviewer must never be told about the budget gate.
    expect(projected[0].content).not.toContain('日预算')
  })

  it('projects membership lines the same way (W6 reuses the marker)', () => {
    const projected = projectRoomHistory({
      messages: [{ role: 'system', content: '小研 加入了群聊', source: COLLAB_SYSTEM_SOURCE_MEMBERSHIP }],
      selfAgentId: 'fe',
      agents: AGENTS,
    })
    expect(projected[0].content).toContain('<History>\n<message from="系统">小研 加入了群聊</message>\n</History>')
  })

  it('projects task facts to the agent they are about, too', () => {
    const projected = projectRoomHistory({ messages: transcript, selfAgentId: 'fe', agents: AGENTS })
    expect(projected[0].content).toContain('<message from="系统">「加 notes.txt」受阻')
    // 事关自己的那条交付,读起来仍然是自己写的那句话。
    expect(projected[0].content).toContain('<message from="小李#fe">已交付,notes.txt 写好了</message>')
  })
})

describe('buildCollabMembershipLines (W6 / §3.5 C 群公告)', () => {
  it('announces arrivals with the avatar mark, departures, then the new PM', () => {
    expect(buildCollabMembershipLines({
      previousMemberIds: ['pm', 'fe'],
      nextMemberIds: ['pm', 'research'],
      previousPmAgentId: 'pm',
      nextPmAgentId: 'research',
      agents: [
        { id: 'pm', name: '阿明', avatar: '📋' },
        { id: 'fe', name: '小李', avatar: '🔧' },
        { id: 'research', name: '小研', avatar: '🔎' },
      ],
    })).toEqual([
      '🔎 小研 加入了群聊',
      '小李 已被移出群聊',
      '小研 成为群负责人',
    ])
  })

  it('states the vacancy without re-naming a PM who just left', () => {
    const agents: CollabAgentLike[] = [{ id: 'pm', name: '阿明' }, { id: 'fe', name: '小李' }]
    expect(buildCollabMembershipLines({
      previousMemberIds: ['pm', 'fe'],
      nextMemberIds: ['fe'],
      previousPmAgentId: 'pm',
      agents,
    })).toEqual(['阿明 已被移出群聊', '群里暂时没有负责人'])

    // Demoted but still in the room — the name belongs in the line.
    expect(buildCollabMembershipLines({
      previousMemberIds: ['pm', 'fe'],
      nextMemberIds: ['pm', 'fe'],
      previousPmAgentId: 'pm',
      agents,
    })).toEqual(['阿明 不再是群负责人'])
  })

  it('says nothing when the roster only got reordered, and falls back to the id', () => {
    expect(buildCollabMembershipLines({
      previousMemberIds: ['pm', 'fe'],
      nextMemberIds: ['fe', 'pm'],
      previousPmAgentId: 'pm',
      nextPmAgentId: 'pm',
      agents: AGENTS,
    })).toEqual([])
    expect(buildCollabMembershipLines({
      previousMemberIds: [],
      nextMemberIds: ['ghost'],
    })).toEqual(['ghost 加入了群聊'])
  })

  it('membership lines are the projected kind — the room must know who left', () => {
    expect(isCollabProjectedSystemLine({
      role: 'system',
      source: COLLAB_SYSTEM_SOURCE_MEMBERSHIP,
    })).toBe(true)
  })
})

describe('buildCollabTaskHaltedLine (W9.2)', () => {
  it('states the fact (not delivered) before the disposition instruction', () => {
    const line = buildCollabTaskHaltedLine({ title: '给项目加 notes.txt', assigneeName: '小李' })
    expect(line).toBe(
      '「给项目加 notes.txt」受阻:小李 无法继续,任务未交付(原因见看板任务卡)。'
      + COLLAB_TASK_HALTED_DISPOSITION,
    )
    expect(line.indexOf('任务未交付')).toBeLessThan(line.indexOf('请负责人决定下一步'))
    // Disposition, not review: 重派/换人/改方案/问用户.
    expect(line).toContain('重新指派')
    expect(line).toContain('换人')
    expect(line).toContain('改方案')
    expect(line).toContain('向用户说明')
    expect(line).not.toContain('评审')
  })

  it('works without a known assignee', () => {
    expect(buildCollabTaskHaltedLine({ title: 'X' })).toContain('「X」受阻:无法继续,任务未交付')
  })

  // W9b.3: 「原因见看板任务卡」 was a dangling pointer — nothing ever wrote it.
  it('carries the reason excerpt instead of the dangling board pointer', () => {
    const line = buildCollabTaskHaltedLine({ title: 'X', assigneeName: '小李', reason: '  没有 write \n 工具  ' })
    expect(line).toContain('(原因: 没有 write 工具)')
    expect(line).not.toContain('原因见看板任务卡')
    expect(line).toContain(COLLAB_TASK_HALTED_DISPOSITION)
  })

  it('excerpts long reasons and keeps the pointer when nothing is knowable', () => {
    const long = buildCollabTaskHaltedLine({ title: 'X', reason: '很'.repeat(300) })
    expect(long).toContain(`原因: ${'很'.repeat(COLLAB_HALT_REASON_EXCERPT_CHARS)}…`)
    expect(buildCollabTaskHaltedLine({ title: 'X', reason: '   ' })).toContain('原因见看板任务卡')
  })
})

describe('halt cap lines (W9b.2)', () => {
  it('states the count, the stop, and that the user decides', () => {
    const line = buildCollabTaskHaltCapLine({ title: '加 notes.txt', haltedCount: 2, assigneeName: '小李', reason: '缺 write' })
    expect(line).toContain('第 2 次受阻')
    expect(line).toContain('(原因: 缺 write)')
    expect(line).toContain('已停止自动处置')
    expect(line).toContain('等用户决定下一步')
    // It must NOT ask anyone to dispose of it — that is the loop being cut.
    expect(line).not.toContain(COLLAB_TASK_HALTED_DISPOSITION)
  })

  it('says a refused re-dispatch executed nothing (no silent death path)', () => {
    const line = buildCollabTaskRequeueRefusedLine({ title: '加 notes.txt', haltedCount: 3 })
    expect(line).toContain('已受阻 3 次')
    expect(line).toContain('没有派出任何执行')
    expect(line).toContain('用户')
  })
})

describe('execution evidence lines (W9b.4)', () => {
  it('formats counts deterministically (count desc, then name)', () => {
    expect(formatCollabTaskEvidence({ toolCounts: { read: 2, write: 1, bash: 2 } }))
      .toBe('bash×2, read×2, write×1')
    expect(formatCollabTaskEvidence({ toolCounts: {} })).toBe('')
    expect(formatCollabTaskEvidence(undefined)).toBe('')
  })

  it('stamps the delivery with the machine-counted trace', () => {
    const line = buildCollabTaskDeliveredLine({
      title: '加 notes.txt',
      assigneeName: '小李',
      evidence: { toolCounts: { write: 1, read: 2 } },
    })
    expect(line).toBe('「加 notes.txt」小李 交付进入评审。执行记录: read×2, write×1')
  })

  it('marks a delivery with zero tool calls as 无执行记录 (the theatre tell)', () => {
    const line = buildCollabTaskDeliveredLine({ title: '加 notes.txt', assigneeName: '小李', evidence: { toolCounts: {} } })
    expect(line).toContain(COLLAB_NO_EVIDENCE_TEXT)
    expect(line).toContain('未经实际执行')
  })

  it('marks a done card with no evidence at all', () => {
    expect(buildCollabTaskDoneLine({ title: '加 notes.txt', evidence: { toolCounts: { write: 1 } } }))
      .toBe('「加 notes.txt」已标记完成。执行记录: write×1')
    const fake = buildCollabTaskDoneLine({ title: '加 notes.txt' })
    expect(fake).toContain(COLLAB_NO_EVIDENCE_TEXT)
    expect(fake).toContain('未经执行验证')
  })
})

describe('formatCollabActivationLabel (W9.2 受阻 vs 交付)', () => {
  it('separates the halted disposition drive from the delivery review drive', () => {
    expect(formatCollabActivationLabel('task-event', COLLAB_DRIVE_LABEL_TASK_HALTED)).toBe('任务受阻待处置')
    expect(formatCollabActivationLabel('task-event', COLLAB_DRIVE_LABEL_TASK_REVIEW)).toBe('任务交付待评审')
    expect(COLLAB_DRIVE_LABEL_TASK_HALTED).not.toBe(COLLAB_DRIVE_LABEL_TASK_REVIEW)
  })

  it('falls back to the reason label when no override is given', () => {
    expect(formatCollabActivationLabel('mention')).toBe('被 @ 激活')
    expect(formatCollabActivationLabel('self-elected')).toBe('主动接话')
    expect(formatCollabActivationLabel('task-event')).toBe('任务事件')
    expect(formatCollabActivationLabel('mention', '   ')).toBe('被 @ 激活')
  })
})

describe('decideCollabActivations', () => {
  const base = {
    members: AGENTS,
    chainCount: 0,
    maxChain: 4,
  }

  it('activates mentioned members in order', () => {
    const result = decideCollabActivations({ ...base, authorKind: 'user', text: '@小李 @小研 一起看看' })
    expect(result.activations).toEqual([
      { agentId: 'fe', reason: 'mention' },
      { agentId: 'research', reason: 'mention' },
    ])
  })

  it('activates nobody by position — a mention-less message goes to willingness', () => {
    const result = decideCollabActivations({ ...base, authorKind: 'user', text: '大家怎么看?' })
    expect(result.activations).toEqual([])
    expect(result.blockedByChain).toBeUndefined()
  })

  it('activates nobody for a mention-less agent message either', () => {
    const result = decideCollabActivations({ ...base, authorKind: 'agent', authorAgentId: 'fe', text: '我说完了' })
    expect(result.activations).toEqual([])
  })

  it('never activates the author itself', () => {
    const result = decideCollabActivations({ ...base, authorKind: 'agent', authorAgentId: 'fe', text: '@小李 @阿明' })
    expect(result.activations).toEqual([{ agentId: 'pm', reason: 'mention' }])
  })

  it('freezes agent-driven chains at the cap and reports the block', () => {
    const result = decideCollabActivations({
      ...base,
      authorKind: 'agent',
      authorAgentId: 'fe',
      text: '@阿明 你看',
      chainCount: 4,
    })
    expect(result.activations).toEqual([])
    expect(result.blockedByChain).toBe(true)
  })

  it('ignores mentions of non-members and honors frozen rooms', () => {
    expect(decideCollabActivations({ ...base, authorKind: 'user', text: '@路人 来' }).activations)
      .toEqual([])
    expect(decideCollabActivations({ ...base, authorKind: 'user', text: '@小李 来', frozen: true }).activations)
      .toEqual([])
  })
})

describe('chain accounting', () => {
  it('counts agent speech, ignores drives/pass, resets on real user messages', () => {
    const drive: CollabMessageLike = { role: 'user', content: 'x', source: 'collab' }
    const speech: CollabMessageLike = { role: 'assistant', content: '发言', agentId: 'fe' }
    const pass: CollabMessageLike = { role: 'assistant', content: '[pass]', agentId: 'fe' }
    const human: CollabMessageLike = { role: 'user', content: '继续' }

    expect(collabMessageCountsTowardChain(speech)).toBe(true)
    expect(collabMessageCountsTowardChain(pass)).toBe(false)
    expect(collabMessageCountsTowardChain({ role: 'assistant', content: '无署名' })).toBe(false)
    expect(collabMessageResetsChain(human)).toBe(true)
    expect(collabMessageResetsChain(drive)).toBe(false)

    expect(computeCollabChainCount([human, drive, speech, speech, human, drive, speech, pass])).toBe(1)
  })

  it('replay agrees with live accounting when harvest posts are mixed in (W12)', () => {
    const drive: CollabMessageLike = { role: 'user', content: 'x', source: 'collab' }
    const speech: CollabMessageLike = { role: 'assistant', content: '发言', agentId: 'fe' }
    const pass: CollabMessageLike = { role: 'assistant', content: '[pass]', agentId: 'fe' }
    const human: CollabMessageLike = { role: 'user', content: '继续' }
    // What coordinator.postAgentMessage writes: signed, but pipeline output.
    const harvest: CollabMessageLike = {
      role: 'assistant',
      content: '【交付】「重构首页」\n做完了',
      agentId: 'fe',
      source: COLLAB_HARVEST_SOURCE,
    }

    expect(isCollabHarvestMessage(harvest)).toBe(true)
    // The harvest marker must not be mistaken for a coordinator drive.
    expect(isCollabDriveMessage(harvest)).toBe(false)
    expect(collabMessageCountsTowardChain(harvest)).toBe(false)

    /** The live path: noteAgentSpoke is called only where the coordinator calls
     *  it — after a real agent turn — and is a noop for harvest posts. */
    const liveCount = (messages: readonly CollabMessageLike[]): number => {
      let count = 0
      for (const message of messages) {
        if (message.role === 'user' && !isCollabDriveMessage(message)) count = 0
        else if (isCollabHarvestMessage(message)) continue // noteAgentSpoke noop
        else if (message.role === 'assistant' && message.agentId && !isCollabPassMessage(message.content)) count += 1
      }
      return count
    }

    const transcript = [
      human, drive, speech,
      harvest, harvest,
      drive, speech, pass,
      harvest,
      drive, speech,
    ]
    expect(liveCount(transcript)).toBe(3)
    expect(computeCollabChainCount(transcript)).toBe(liveCount(transcript))

    // A human message still resets both sides to zero.
    expect(computeCollabChainCount([...transcript, human])).toBe(liveCount([...transcript, human]))
  })
})

describe('buildCollabRoomContext', () => {
  it('states the situation as facts: room, members, relay format — no rules', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
    })
    expect(context).toContain('「官网改版项目组」')
    expect(context).toContain('<room name="官网改版项目组">')
    // 花名册一人一行(2026-08-01 整理):这份名单的用处是被照抄。
    expect(context).toContain('- 用户')
    expect(context).toContain('- 阿明#pm(产品经理)')
    expect(context).toContain('- 小研#research(研究员)')
    expect(context).not.toContain('小李') // self is not listed to itself
    expect(context).toContain('`name: text`')
    // Capability facts prevent collective confabulation ("我扫了项目结构"
    // with zero tools) and dead discussions (members not @-ing each other).
    expect(context).toContain('board')
    expect(context).toContain('work session')
    expect(context).toContain('@name')
    // No stage directions, no rule lists, no pass instruction.
    expect(context).not.toContain('铁律')
    expect(context).not.toContain('[pass]')
    expect(context).not.toContain('<rules>')
    expect(context).not.toContain('扮演')
  })

  /**
   * 2026-08-01 整理:块边界靠标签闭合,不靠一个孤零零的右括号 —— 旧文本的
   * 闭括号粘在最后一行句号后面(`…建卡指派给合适的成员。)`),模型要靠它判断
   * 「情况说明结束了」。
   */
  it('每一段都是闭合的 XML,没有半开的块', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
    })
    for (const tag of ['where_you_are', 'room', 'messaging', 'board', 'your_tools']) {
      expect(context).toContain(`</${tag}>`)
    }
    // 旧形态的全角括号包裹不该有残留。
    expect(context).not.toContain('(情况说明:')
  })

  /**
   * 「你写的字停在这里 + 只有发送出得去」是全篇最吃重的一条,2026-08-01 之前它在
   * 情况说明、通用规则、驱动信封里各有一份**逐字副本** —— 同一句话说三遍不会
   * 变成三倍重要,只会读成模板套话。现在它只在 `<where_you_are>` 出现一次。
   */
  it('工位那句话在整份系统提示词里只说一次', () => {
    const prompt = buildCollabRoomSystemPrompt({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      personaPrompt: '你是小李。',
      includeCommonRules: true,
    })
    const occurrences = prompt.split('stays here: what you write is a note to yourself').length - 1
    expect(occurrences).toBe(1)
  })

  /**
   * 身份句柄(docs/design/collab-agent-handle.md)。花名册是 agent **唯一**能
   * 学到句柄的地方 —— 它没有 picker,而 say/dm/board 三个工具都要指认「谁」。
   */
  it('每位成员都带句柄,而且是「名字#句柄(职位)」这个可照抄的形状', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
    })
    // 句柄拼在名字后面,不是整个标签后面:与正文里要写的 token 逐字一致。
    expect(context).toContain('阿明#pm(产品经理)')
    expect(context).not.toContain('阿明(产品经理)#')
    // 而且教了怎么用它。
    expect(context).toContain('@name#handle')
    // 不传 userHandle 时用户行只有称呼(私聊两版的散文不塞句柄)。
    expect(context).toContain('- 用户\n')
  })

  /**
   * agent-dm-user.md §2.3:用户行与同事行同一书写法,「(用户)」占「(职位)」
   * 那一格 —— agent 学得到同事的句柄却学不到用户的,`dm to:"一天#yitian"` 就
   * 只能靠猜。
   */
  it('传了身份:用户行写成「名字#句柄(用户)」', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      userLabel: '一天',
      userHandle: 'yitian',
    })
    expect(context).toContain('- 一天#yitian(用户)')
    expect(context).toContain('- 阿明#pm(产品经理)')
    expect(context).not.toContain('- 用户')
  })

  it('只传称呼不传句柄:退回单独一个称呼,不编一个句柄出来', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      userLabel: '一天',
    })
    expect(context).toContain('- 一天\n')
    expect(context).toContain('- 阿明#pm(产品经理)')
  })

  /**
   * 花名册**默认写在 `<room>` 里**(collab-turn-protocol-and-identity.md B)。
   * 它曾被搬进 `<ChatRoom><Members>`,而 v3 V2 删掉了那块载荷 —— 名单从此指向
   * 一段不存在的文本,模型于是把用户与花名册上的名字数成两个人(幽灵成员)。
   */
  it('真回合:花名册在 <room> 里,用户行与同事行同一书写法', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      userLabel: '一天',
      userHandle: 'yitian',
      rosterInSystemPrompt: true,
      driveEnvelope: true,
    })
    expect(context).toContain('<room name="官网改版项目组">')
    expect(context).toContain('- 一天#yitian(用户)')
    expect(context).toContain('- 阿明#pm(产品经理)')
    expect(context).toContain('in the roster above')
    // 真回合的消息形状是 drive 信封,不是判定那一路的压缩窗口。
    expect(context).toContain('`<message from="名字#句柄">` lines')
    expect(context).not.toContain('`name: text`')
    expect(context).not.toContain('`<ChatRoom>` block')
  })

  /**
   * 视野说明是 **drive 的属性**,与花名册在哪无关(B.2:两个正交开关)。
   */
  it('视野说明跟着 driveEnvelope 走,不跟着花名册走', () => {
    const withEnvelope = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      driveEnvelope: true,
    })
    expect(withEnvelope).toContain('<Notification>')
    expect(withEnvelope).toContain('<Folded count=')
    // drive 形态下没有 `<History>` 标签 —— 读过的消息就散在历史里。
    expect(withEnvelope).not.toContain('`<History>`')

    const judgement = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
    })
    expect(judgement).not.toContain('<Notification>')
  })

  /**
   * 判定那一路不传任何开关:花名册照旧在,压缩窗口的 relay 说明照旧在。
   */
  it('不传就照旧:判定那一路的花名册一个字没少', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      userLabel: '一天',
      userHandle: 'yitian',
    })
    expect(context).toContain('- 一天#yitian(用户)')
    expect(context).toContain('- 阿明#pm(产品经理)')
    expect(context).toContain('`name: text`')
    expect(context).toContain('in the roster above')
    expect(context).not.toContain('<ChatRoom>')
  })

  /**
   * 判定薄档(D.1):判定是零工具的裸调用,`<your_tools>`/状态板/`<board>`
   * 对它而言字字是假话。
   */
  it('判定薄档裁掉工具面、状态板与看板段', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      judgement: true,
    })
    expect(context).not.toContain('<your_tools>')
    expect(context).not.toContain('<board>')
    expect(context).not.toContain('context-variable board')
    // 场子与花名册仍然要在:判定要知道自己在哪、有谁。
    expect(context).toContain('<where_you_are>')
    expect(context).toContain('<room name="官网改版项目组">')
  })

  it('句柄只给模型 —— 群里看到的仍然是「@名字」,这一点写在情况说明里', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
    })
    expect(context).toContain('What the chat displays is still `@name`')
  })
})

/**
 * `<your_cards>` 已退役(agent-self-state-variables.md §4.4):在飞的卡改由
 * `my_cards` 变量承载,格式与"不指挥"的纪律钉在
 * variables/__tests__/agent-self.test.ts。这里守的是它留下的两个洞:
 * 手写那一段真的没了,以及变量板这件事在群房里被说了出来。
 */
describe('variable board fact (P3 群聊解禁变量通道)', () => {
  it('no longer hand-writes the in-flight cards into the room note', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
    })
    expect(context).not.toContain('<your_cards>')
    expect(context).not.toContain('you are executing it in a work session')
  })

  it('states that the variable board exists here, without telling the agent to use it', () => {
    const context = buildCollabRoomContext({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
    })
    expect(context).toContain('The context-variable board is here too')
    expect(context).toContain('`variable` tool')
    // 只陈述事实,不指挥(roster 铁律 + W22 的教训:督促换来废话行为)。
    expect(context).not.toContain('remember to')
    expect(context).not.toContain('you should')
    expect(context).not.toContain('make sure to')
    // 变量不再承担状态语义:这句只说板在,不再兜售"存这儿能活过摘要"。
    expect(context).not.toContain('state board')
    expect(context).not.toContain('re-sent in full every turn')
  })

  it('keeps the persona verbatim in front of the workspace', () => {
    const prompt = buildCollabRoomSystemPrompt({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      personaPrompt: '你是小李,前端工程师。',
    })
    expect(prompt.startsWith('你是小李,前端工程师。')).toBe(true)
  })
})

describe('buildCollabRoomSystemPrompt', () => {
  it('is the persona VERBATIM plus only the factual room note', () => {
    const persona = '你是小李,前端工程师。口头禅是"从实现角度讲"。'
    const prompt = buildCollabRoomSystemPrompt({
      self: AGENTS[1],
      members: AGENTS,
      roomName: '官网改版项目组',
      personaPrompt: persona,
    })
    // persona 在 XML **外面**:它是这个 agent 的身份原文,包进 harness 造的
    // 标签里就变成了"系统提供的一段资料"。
    expect(prompt.startsWith(persona)).toBe(true)
    expect(prompt).toContain('<workspace>')
    expect(prompt.indexOf(persona)).toBeLessThan(prompt.indexOf('<workspace>'))
    expect(prompt.endsWith('</workspace>')).toBe(true)
    // Nothing prepended, no wrapper sentences, no product identity.
    expect(prompt).not.toContain('你就是「')
    expect(prompt).not.toContain('扮演')
    expect(prompt).not.toContain('AI assistant')
  })

  it('falls back to a minimal persona line when the agent has no prompt', () => {
    const prompt = buildCollabRoomSystemPrompt({
      self: { id: 'x', name: '无声' },
      members: AGENTS,
      roomName: 'r',
      personaPrompt: '',
    })
    expect(prompt.startsWith('你是无声。')).toBe(true)
  })
})

// R4 / P2-13 的 `mergeCollabProjectedRows` 及其这一组用例已于 C2-1 删除:那个
// 函数唯一的存活理由是"执行会话那一支还要用它",而 W18 之后执行会话走的是普通
// 会话那条路,生产零调用点 —— 剩下的只是一组在证明自己还活着的用例。相邻同侧
// 行的合并若再需要,从 git 历史取回。下面这组钉的是**另一半**,与它无关。

/**
 * 一条消息一个信封,一间房一块 History(collab-chatroom-payload.md)。
 *
 * 相邻合并那件事已经不在房间侧发生了 —— 整块就是一行,没有相邻的行可合。留下
 * 这组用例是为了钉住另一半:塌成一块之后,**每条发言仍然是独立的一条**,say
 * 调三次就是三个信封,不能被拼成一段。
 */
describe('projectRoomHistory — 一块 History,一条消息一个信封', () => {
  const MEMBERS = [{ id: 'fe', name: '小李' }, { id: 'pm', name: '阿明' }]
  const say = (agentId: string, content: string) =>
    ({ role: 'assistant' as const, agentId, content, source: 'collab-say' })

  it('自己的三次 say 是三个信封,不是一段独白', () => {
    const projected = projectRoomHistory({
      messages: [say('fe', '一'), say('fe', '二'), say('fe', '三')],
      selfAgentId: 'fe',
      agents: MEMBERS,
    })
    expect(projected).toHaveLength(1)
    expect(projected[0].role).toBe('user')
    expect(projected[0].content).toContain(
      '<message from="小李#fe">一</message>\n<message from="小李#fe">二</message>\n<message from="小李#fe">三</message>',
    )
  })

  it('别人的连续发言同样一条一个信封', () => {
    const projected = projectRoomHistory({
      messages: [say('fe', '一'), say('fe', '二')],
      selfAgentId: 'pm',
      agents: MEMBERS,
    })
    expect(projected[0].content).toContain('<message from="小李#fe">一</message>\n<message from="小李#fe">二</message>')
  })

  it('系统行按发生顺序夹在中间', () => {
    const projected = projectRoomHistory({
      messages: [
        say('fe', '一'),
        { role: 'system', content: '「加 notes.txt」→ 小李 开始执行', source: 'collab-task' },
        say('fe', '二'),
      ],
      selfAgentId: 'pm',
      agents: MEMBERS,
    })
    expect(projected).toHaveLength(1)
    expect(projected[0].role).toBe('user')
    expect(projected[0].content).toContain('<message from="小李#fe">一</message>\n<message from="系统">「加 notes.txt」→ 小李 开始执行</message>\n<message from="小李#fe">二</message>')
  })
})

/**
 * R7 / P2-17 — a freeze that eats an @ says so.
 *
 * Writing 「@小李 看一下」 into a room paused an hour ago produced nothing at
 * all: no answer, no refusal. That reads as a broken room rather than a paused
 * one. The decision now reports the swallowed mention so the coordinator can
 * post one line per freeze.
 */
describe('decideCollabActivations — 冻结吞 @ 出信号 (P2-17)', () => {
  it('flags a mention the freeze swallowed', () => {
    const decision = decideCollabActivations({
      authorKind: 'user',
      text: '@小李 看一下这个',
      members: AGENTS,
      chainCount: 0,
      maxChain: 8,
      frozen: true,
    })
    expect(decision.activations).toEqual([])
    expect(decision.blockedByFrozen).toBe(true)
  })

  it('stays quiet when the frozen room was not addressed', () => {
    const decision = decideCollabActivations({
      authorKind: 'user',
      text: '随便说一句',
      members: AGENTS,
      chainCount: 0,
      maxChain: 8,
      frozen: true,
    })
    expect(decision.blockedByFrozen).toBeUndefined()
  })

  it('does not apologise for a name that is not in the room', () => {
    const decision = decideCollabActivations({
      authorKind: 'user',
      text: '@路人甲 在吗',
      members: AGENTS,
      chainCount: 0,
      maxChain: 8,
      frozen: true,
    })
    expect(decision.blockedByFrozen).toBeUndefined()
  })

  it('says nothing new when the room is open — the flag is freeze-only', () => {
    const decision = decideCollabActivations({
      authorKind: 'user',
      text: '@小李 看一下这个',
      members: AGENTS,
      chainCount: 0,
      maxChain: 8,
    })
    expect(decision.blockedByFrozen).toBeUndefined()
    expect(decision.activations.map(entry => entry.agentId)).toEqual(['fe'])
  })
})
