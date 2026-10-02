/**
 * 句柄编解码的**不变式** —— docs/design/collab-handle-codec.md §2.5。
 *
 * 前面那些用例各自钉住一个行为;这一条钉的是整套机制赖以成立的那个等式:
 *
 *     解码(编码(x)) 不含句柄     对身份域 × 形态域的**每一个**组合成立
 *
 * 之所以要写成乘积遍历而不是几条挑出来的例子:上一次的 bug(用户、退休成员、
 * 非本房成员的句柄泄漏进转录,实测 35 处)能活下来,正是因为没有任何一条测试
 * 同时看着编码与解码两侧 —— 出站给谁发了句柄、入站认不认得,是两份各自演化的
 * 名单。**新增一种身份、或新增一个出站点却忘了解码路径,这里必须红。**
 */
import { describe, expect, it } from 'vitest'
import {
  collabIdentityFromAgent,
  collabUserIdentity,
  type CollabIdentity,
} from '../identity.js'
import {
  formatCollabAgentHandle,
  parseCollabHandleMentions,
  stripCollabAgentHandles,
} from '../handles.js'

/** 身份域:出站会给句柄的每一种人(collab-handle-codec.md §1 轴一)。 */
const ACTIVE = collabIdentityFromAgent({ id: 'agent-3f9c1e2a-1111-4222-8333-444455556666', name: '小李' })
const RETIRED = collabIdentityFromAgent({ id: 'agent-7b41c8d9-1111-4222-8333-444455556666', name: '阿明' })
const OUTSIDER = collabIdentityFromAgent({ id: 'agent-c0ffee11-1111-4222-8333-444455556666', name: '老王' })
const USER = collabUserIdentity('songyitian', '666666')
/** 内置 default agent 的 id 不是 uuid —— 句柄规则的短 id 分支也进乘积。 */
const DEFAULT_AGENT = collabIdentityFromAgent({ id: 'default', name: '默认' })

const DIRECTORY: CollabIdentity[] = [ACTIVE, RETIRED, OUTSIDER, USER, DEFAULT_AGENT]

const IDENTITIES: Array<[string, CollabIdentity]> = [
  ['在职成员', ACTIVE],
  ['退休成员', RETIRED],
  ['非本房 agent', OUTSIDER],
  ['用户本人', USER],
  ['内置 default agent', DEFAULT_AGENT],
]

/**
 * 形态域:出站真的会写出的每一种形状(§1 轴二)。
 *
 *  - `@名字#句柄` —— 正文 @ 重绘(renderCollabModelMention)
 *  - `名字#句柄`  —— 花名册行、信封 from、意愿窗口、看板摘要
 *  - `@#句柄`     —— dm 工具描述教的简写
 */
const FORMS: Array<[string, (identity: CollabIdentity) => string]> = [
  ['@名字#句柄', identity => `@${nameHandle(identity)}`],
  ['名字#句柄(裸)', identity => nameHandle(identity)],
  ['@#句柄', identity => `@#${identity.handle}`],
]

function nameHandle(identity: CollabIdentity): string {
  return identity.kind === 'user'
    ? `${identity.label}#${identity.handle}`
    : formatCollabAgentHandle(identity.agentId, identity.label)
}

describe('句柄编解码不变式:解码域 ⊇ 编码域', () => {
  for (const [who, identity] of IDENTITIES) {
    for (const [shape, encode] of FORMS) {
      it(`${who} × ${shape} —— 落库前句柄必须被剥净`, () => {
        const encoded = `开工前说一句 ${encode(identity)} 收到请回`
        const stripped = stripCollabAgentHandles(encoded, DIRECTORY)

        expect(stripped).not.toContain(`#${identity.handle}`)
        // 剥完还得是句人话:名字还在,句子其余部分一个字不动。
        expect(stripped).toContain(identity.label)
        expect(stripped.startsWith('开工前说一句 ')).toBe(true)
        expect(stripped.endsWith(' 收到请回')).toBe(true)
      })
    }
  }

  it('看板短卡号不许被当成句柄吃掉 —— 两者形状相同,靠位置区分', () => {
    // 独立成词的 `#8位`:卡号的地盘,即使值恰好等于某人的句柄也不动它。
    const text = `卡 #463fc4ca 做完了,另外 #${ACTIVE.handle} 这串也别动`
    expect(stripCollabAgentHandles(text, DIRECTORY)).toBe(text)
  })

  it('名实不符的裸写法不剥 —— 「完成#句柄」不是在说人', () => {
    const text = `完成#${ACTIVE.handle} 这个写法与任何人都对不上`
    expect(stripCollabAgentHandles(text, DIRECTORY)).toBe(text)
  })

  it('用户的常量词别名同样吃得下(模型自己拼的写法)', () => {
    // 现场实证:模型把花名册给的句柄与工具描述给的「用户」拼成了第三种写法。
    expect(stripCollabAgentHandles('dm 用 `用户#666666` 格式是通的', DIRECTORY))
      .toBe('dm 用 `用户` 格式是通的')
  })

  it('目录之外的句柄原样留着 —— 模型写错了,它下一轮看得见自己写错了', () => {
    const text = '@小李#deadbeef 你的句柄是这个吗'
    expect(stripCollabAgentHandles(text, DIRECTORY)).toBe(text)
  })
})

describe('点名 ≠ 提到:只有带 @ 的进 mentions', () => {
  it('带 @ 的进,裸写的不进', () => {
    const text = `@${nameHandle(ACTIVE)} 你来,另外我问过 ${nameHandle(RETIRED)} 了`
    const mentions = parseCollabHandleMentions(text, DIRECTORY)
    expect(mentions.map(mention => mention.label)).toEqual(['小李'])
    // 但两处句柄都该被剥掉 —— 剥离面比点名面宽,这是刻意的。
    const stripped = stripCollabAgentHandles(text, DIRECTORY)
    expect(stripped).not.toContain('#')
  })

  it('点到用户:句柄落在 userHandle,agentId 留空(不把非 agent 的值塞进 agentId)', () => {
    const mentions = parseCollabHandleMentions(`@${nameHandle(USER)} 你说了算`, DIRECTORY)
    expect(mentions).toEqual([
      { kind: 'user', agentId: '', label: 'songyitian', userHandle: '666666' },
    ])
  })

  it('merge 之后句柄还在 —— 丢字段是"存了等于没存"的经典出口', async () => {
    const { mergeCollabMentions } = await import('../mentions.js')
    const parsed = parseCollabHandleMentions(`@${nameHandle(USER)} 在吗`, DIRECTORY)
    expect(mergeCollabMentions([], parsed)).toEqual([
      { kind: 'user', agentId: '', label: 'songyitian', userHandle: '666666' },
    ])
  })

  it('用户那一条进不了激活 —— 消费方的空值门是它安全的全部理由', () => {
    const mentions = parseCollabHandleMentions(`@${nameHandle(USER)} 在吗`, DIRECTORY)
    // unionTurnMentions / normalizeCollabMentions 都是 `if (!agentId) continue`
    const activatable = mentions.filter(mention => mention.agentId)
    expect(activatable).toEqual([])
  })
})
