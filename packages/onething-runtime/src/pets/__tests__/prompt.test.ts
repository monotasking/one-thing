/**
 * 提示词与回复解析(宠物 P4,正本 §11.2 / §11.5 第一条)。钟与记忆都是钉死的,
 * 于是提示词逐字快照:改一个字都要有人看过这份 diff。
 */
import { describe, expect, it } from 'vitest'
import { HEIDOU } from '../builtin/heidou.js'
import type { PetLedgerLine } from '../ledger.js'
import { buildMomentPrompt, parseMomentReply, PET_PROMPT_MEMORY_LINES } from '../prompt.js'
import type { Moment } from '../types.js'

const AT = 1_789_000_000_000

const MOMENT: Moment = {
  scheme: 'music',
  event: 'skipStreak',
  weight: 'high',
  gist: '用户连着跳过了好几首,可能不喜欢现在的方向',
  payload: { count: 3, titles: ['晴天', '稻香', '夜曲'] },
  at: AT,
}

const MEMORY: PetLedgerLine[] = [
  { kind: 'moment', petId: 'heidou', at: AT - 9_000, scheme: 'music', event: 'trackStarted', weight: 'low', gist: '开始放一首歌', payload: { title: '晴天' } },
  { kind: 'utterance', petId: 'heidou', at: AT - 8_000, utterance: { id: 'u1', petId: 'heidou', mode: 'speak', text: '晴天来了。', at: AT - 8_000, duck: true } },
  { kind: 'hushed', petId: 'heidou', at: AT - 7_000, utteranceId: 'u1' },
  { kind: 'dropped', petId: 'heidou', at: AT - 6_000, reason: 'cooldown', about: { scheme: 'music', event: 'interlude' } },
  { kind: 'utterance', petId: 'heidou', at: AT - 5_000, utterance: { id: 'u2', petId: 'heidou', mode: 'mutter', text: '呼噜', at: AT - 5_000, duck: false } },
  { kind: 'moment', petId: 'heidou', at: AT - 1_000, scheme: 'music', event: 'skipped', weight: 'low', gist: '用户跳过了一首歌', payload: { title: '稻香' } },
]

describe('buildMomentPrompt', () => {
  it('renders persona + rules as system, and gist / payload / memory / local time as user', () => {
    const prompt = buildMomentPrompt({ pet: HEIDOU, moment: MOMENT, memory: MEMORY, localTime: '2026-09-18 星期五 02:14', locale: 'zh-CN' })
    expect(prompt).toMatchSnapshot()
  })

  it('keeps only the last 10 ledger lines and leaves budget bookkeeping out', () => {
    const many: PetLedgerLine[] = Array.from({ length: 15 }, (_, i) => ({
      kind: 'moment', petId: 'heidou', at: AT + i, scheme: 'music', event: 'trackStarted', weight: 'low', gist: `第${i}件事`,
    }))
    const { user } = buildMomentPrompt({ pet: HEIDOU, moment: MOMENT, memory: many, localTime: 't', locale: 'zh-CN' })
    expect(user).not.toContain('第4件事')
    expect(user).toContain('第5件事')
    expect(user.match(/^- 第/gm)).toHaveLength(PET_PROMPT_MEMORY_LINES)

    const { user: withBudget } = buildMomentPrompt({ pet: HEIDOU, moment: MOMENT, memory: MEMORY, localTime: 't', locale: 'zh-CN' })
    expect(withBudget).not.toContain('cooldown')
    expect(withBudget).not.toContain('u1')
  })

  it('says there is no memory and no detail when both are empty, and truncates a huge payload', () => {
    const empty = buildMomentPrompt({ pet: HEIDOU, moment: { ...MOMENT, payload: {} }, memory: [], localTime: 't', locale: 'zh-CN' })
    expect(empty.user).toContain('细节:(无)')
    expect(empty.user).toContain('- (没有)')
    const huge = buildMomentPrompt({ pet: HEIDOU, moment: { ...MOMENT, payload: { titles: Array.from({ length: 200 }, (_, i) => `歌${i}`) } }, memory: [], localTime: 't', locale: 'zh-CN' })
    expect(huge.user).toContain('…(截断)')
  })
})

describe('parseMomentReply', () => {
  it.each([
    ['plain JSON', '{"say": "我也不爱这首。"}', '我也不爱这首。'],
    ['fenced JSON', '```json\n{"say":"换个方向吧"}\n```', '换个方向吧'],
    ['bare fence', '```\n{"say":"嗯"}\n```', '嗯'],
    ['chatter around', '好的,这是我的回复:{"say": "夜深了。"} 希望合适', '夜深了。'],
    ['braces inside the string', '{"say": "我画了个 {笑脸}"}', '我画了个 {笑脸}'],
    ['whitespace around the line', '{"say": "  嗨  "}', '嗨'],
    ['a stray object before the real one', '{"note": 1} {"say": "第二个才是"}', '第二个才是'],
    ['an array wrapping the object', '[{"say":"hi"}]', 'hi'],
  ])('takes the line from %s', (_name, reply, expected) => {
    expect(parseMomentReply(reply)).toBe(expected)
  })

  it.each([
    ['explicit null', '{"say": null}'],
    ['empty string', '{"say": ""}'],
    ['blank string', '{"say": "   "}'],
    ['not a string', '{"say": 42}'],
    ['free text, no JSON', '我觉得可以说点什么'],
    ['broken JSON', '{"say": "没收尾'],
    ['no say key', '{"text": "hi"}'],
    ['empty reply', ''],
  ])('answers null for %s', (_name, reply) => {
    expect(parseMomentReply(reply)).toBeNull()
  })
})
