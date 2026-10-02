import { describe, expect, it } from 'vitest'
import {
  RADIO_DJ_FACTORY_VERSION,
  radioDjFactoryPromptVersion,
  renderRadioCurationPrompt,
  renderRadioDjAgentPrompt,
  renderRadioOpenPrompt,
  renderRadioTalkPrompt,
} from '../radio-render.js'
import type { OnethingRadioBrief } from '../radio-store.js'

const brief = (intent: string): OnethingRadioBrief => ({
  active: true,
  intent,
  played: [],
  skipped: [],
  loved: [],
})

const options = (intent: string) => ({
  brief: brief(intent),
  inboxPath: '/tmp/inbox.json',
  localTime: '2026/7/17 12:00:00',
})

describe('radio prompt intent line', () => {
  it('quotes a real intent inside the untrusted tag, escaped', () => {
    const prompt = renderRadioOpenPrompt(options('下雨天,安静的<中文>民谣'))
    expect(prompt).toContain('<untrusted_intent>下雨天,安静的&lt;中文&gt;民谣</untrusted_intent>')
  })

  it('degrades debris intents to a self-direct instruction instead of quoting them', () => {
    // The 'x' fixture that leaked through a broken test mock (2026-07-17)
    // stalled a DJ turn: it asked the unattended session for direction.
    for (const debris of ['x', '', ' ', '?']) {
      const prompt = renderRadioOpenPrompt(options(debris))
      expect(prompt).not.toContain('<untrusted_intent>')
      expect(prompt).toContain('不要提问')
      expect(prompt).toContain('自主定调')
    }
  })

  it('the curation prompt applies the same degradation', () => {
    const prompt = renderRadioCurationPrompt({ ...options('x'), programmeRemaining: ['song A'] })
    expect(prompt).not.toContain('<untrusted_intent>')
    expect(prompt).toContain('自主定调')
    expect(prompt).toContain('- song A')
  })

  it('two characters is already a legitimate direction (随便)', () => {
    const prompt = renderRadioOpenPrompt(options('随便'))
    expect(prompt).toContain('<untrusted_intent>随便</untrusted_intent>')
  })
})

describe('life context in the opening prompt', () => {
  it('renders the listener snapshot into the open prompt only', () => {
    const lifeContext = '- notes: 下午交周报\n- goal: 修完电台'
    const open = renderRadioOpenPrompt({ ...options('雨天民谣'), lifeContext })
    expect(open).toContain('- notes: 下午交周报')
    expect(open).toContain('只作素材')

    // Transitions run on time + listening feedback; no life context there.
    const curate = renderRadioCurationPrompt({ ...options('雨天民谣'), lifeContext, programmeRemaining: [] })
    expect(curate).not.toContain('下午交周报')
  })

  it('an absent or blank snapshot degrades to (无)', () => {
    expect(renderRadioOpenPrompt(options('雨天民谣'))).toContain('(无)')
    expect(renderRadioOpenPrompt({ ...options('雨天民谣'), lifeContext: '  ' })).toContain('(无)')
  })
})

describe('radio dj factory persona', () => {
  it('carries the mandatory disciplines and the concrete inbox path', () => {
    // Mandatory rules live in the PERSONA, not the turn templates: a stale DJ
    // chatted into curating shipped six rights-restricted songs (2026-07-17)
    // because the discipline only rode the automated wake prompts.
    const prompt = renderRadioDjAgentPrompt({ inboxPath: '/tmp/inbox.json' })
    expect(prompt).toContain('playFlag: true')
    expect(prompt).toContain('/tmp/inbox.json')
    expect(prompt).toContain('programme.json')
  })

  it('is fingerprinted so installed agents can follow factory upgrades', () => {
    const prompt = renderRadioDjAgentPrompt({ inboxPath: '/tmp/inbox.json' })
    expect(radioDjFactoryPromptVersion(prompt)).toBe(RADIO_DJ_FACTORY_VERSION)
    // No fingerprint (pre-v2 install or user-authored) reads as null.
    expect(radioDjFactoryPromptVersion('你是这台个人电台的主持人。')).toBeNull()
  })

  it('turn templates no longer carry the mandatory playability rule', () => {
    expect(renderRadioOpenPrompt(options('雨天民谣'))).not.toContain('playFlag')
    expect(
      renderRadioCurationPrompt({ ...options('雨天民谣'), programmeRemaining: [] }),
    ).not.toContain('playFlag')
  })
})

/**
 * 听众说的那一句(2026-09-18,正本 `apps/desktop-react/docs/music-panel-2026-09.md` §7.1)。
 */
describe('radio talk prompt', () => {
  const talk = (message: string) =>
    renderRadioTalkPrompt({ ...options('下雨天,安静点的'), programmeRemaining: ['song 1'], message })

  it('人说的字与开台意图同一档待遇:转义 + 裹在不可信标签里', () => {
    const prompt = talk('  换个 <script>心情  ')
    expect(prompt).toContain('<untrusted_listener_message>换个 &lt;script&gt;心情</untrusted_listener_message>')
  })

  it('交代那一句说清三件事:可以改节目单、最后那句就是回话、不说也行', () => {
    const prompt = talk('换个心情')
    expect(prompt).toContain('听众在跟你说话')
    expect(prompt).toContain('/tmp/inbox.json')
    expect(prompt).toContain('最后收尾的那句话,就是你要对他说的话')
    expect(prompt).toContain('不吭声是可以的')
  })

  it('照旧带着本台意图与还剩哪些 —— 一条 wake 的前置在这里同样成立', () => {
    const prompt = talk('慢一点')
    expect(prompt).toContain('<untrusted_intent>下雨天,安静点的</untrusted_intent>')
    expect(prompt).toContain('- song 1')
    expect(prompt).toContain('2026/7/17 12:00:00')
  })
})
