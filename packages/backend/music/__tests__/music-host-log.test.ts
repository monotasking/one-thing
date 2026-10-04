import { describe, expect, it } from 'vitest'
import {
  describeCommandLine,
  describeHostDoing,
  describeToolCall,
  projectHostLog,
  type HostLogMessage,
  type HostLogToolCall,
} from '../music-host-log.js'
import { renderRadioCurationPrompt, renderRadioOpenPrompt, renderRadioTalkPrompt } from '../music-radio-render.js'
import type { OnethingRadioBrief } from '../music-radio-store.js'

const brief = (intent: string): OnethingRadioBrief => ({ active: true, intent, played: [], skipped: [], loved: [] })
const renderOptions = (intent: string) => ({
  brief: brief(intent),
  inboxPath: '/store/music/programme-inbox.json',
  localTime: '2026/9/26 22:10:00',
})

const SEARCH_STDOUT = [
  '│ 有新版本: 0.1.6 → 0.1.7',
  JSON.stringify({
    code: 200,
    data: {
      recordCount: 272,
      records: [
        { id: 'A'.repeat(32), name: '想你就写信', playFlag: false },
        { id: 'B'.repeat(32), name: '想你就写信 (Live)', playFlag: true },
      ],
    },
  }),
].join('\n')

const bash = (command: string, extra: Partial<HostLogToolCall> = {}): HostLogToolCall => ({
  id: extra.id ?? 'call-1',
  toolName: 'bash',
  toolId: 'bash',
  arguments: { command },
  status: 'completed',
  ...extra,
})

describe('host-log verb table', () => {
  it('search: keyword in the label, count and the first playable record in the detail', () => {
    const described = describeToolCall(bash('ncm-cli search song --keyword "想你就写信 浅影阿"', { result: SEARCH_STDOUT }))
    expect(described).toEqual({ verb: 'search', label: '搜「想你就写信 浅影阿」', detail: '272 首,选了「想你就写信 (Live)」' })
  })

  it('search: a head -c truncated result still yields the count', () => {
    const cut = SEARCH_STDOUT.slice(0, SEARCH_STDOUT.indexOf('playFlag'))
    const described = describeToolCall(bash('ncm-cli search song --keyword=晴天 | head -c 4000', { result: cut }))
    expect(described.verb).toBe('search')
    expect(described.label).toBe('搜「晴天」')
    expect(described.detail).toBe('272 首,第一首「想你就写信」')
  })

  it('search: structured tool results are read through their text parts', () => {
    const described = describeToolCall(bash('ncm-cli search song --keyword 晴天', {
      result: { content: [{ type: 'text', text: SEARCH_STDOUT }] },
    }))
    expect(described.detail).toBe('272 首,选了「想你就写信 (Live)」')
  })

  it('lyric: the first sung line, credits skipped', () => {
    const lyric = '[00:00.000]作词 : 毛不易\n[00:03.320]光落在你脸上\n[00:08.000]可爱一如往常'
    const described = describeToolCall(bash('ncm-cli song lyric --songId ABC', {
      result: JSON.stringify({ data: { lyric, noLyric: false } }),
    }))
    expect(described).toEqual({ verb: 'lyric', label: '翻歌词', detail: '「光落在你脸上」' })
  })

  it('queue: a heredoc into the programme inbox lists the song titles', () => {
    const command = [
      "cat > /store/music/programme-inbox.json <<'EOF'",
      JSON.stringify({ entries: [
        { encryptedId: 'x', title: '想你就写信 (Live) - 浅影阿', say: '…' },
        { encryptedId: 'y', title: '柔软 - 林宥嘉', say: '…' },
      ] }),
      'EOF',
    ].join('\n')
    const described = describeToolCall(bash(command, { result: '' }))
    expect(described).toEqual({
      verb: 'queue',
      label: '排进节目单',
      songs: ['想你就写信 (Live)', '柔软'],
      detail: '想你就写信 (Live)、柔软',
    })
  })

  it('queue: a write tool aimed at the inbox counts too', () => {
    const described = describeToolCall({
      id: 'w',
      toolName: 'write',
      arguments: { path: '/store/music/programme-inbox.json', content: '{"entries":[{"title":"借我 - 谢春花"}]}' },
      status: 'completed',
      result: 'ok',
    })
    expect(described.verb).toBe('queue')
    expect(described.songs).toEqual(['借我'])
  })

  it('other ncm-cli commands: the command itself, ncm-cli stripped', () => {
    const described = describeToolCall(bash('ncm-cli comment list-hot --type 0 --resourceId ABC --limit 5', { result: '{}' }))
    expect(described).toEqual({ verb: 'command', label: 'comment list-hot --type 0 --resourceId ABC --limit 5' })
    expect(describeCommandLine('ncm-cli user info').label).toBe('user info')
  })

  it('unknown commands fall back to the generic row, odd input never throws', () => {
    expect(describeToolCall(bash('ls -la', { result: 'x' }))).toEqual({ verb: 'command', label: '跑了一条命令' })
    expect(describeToolCall({ id: 'z', toolName: 'read', arguments: { path: '/x' } })).toEqual({ verb: 'command', label: '跑了一条命令' })
    expect(describeToolCall(null)).toEqual({ verb: 'command', label: '跑了一条命令' })
    expect(describeToolCall({ arguments: 42 as unknown as object, result: { weird: true } }).verb).toBe('command')
    expect(describeCommandLine(undefined as unknown as string)).toEqual({ verb: 'command', label: '跑了一条命令' })
  })

  it('failed calls carry the first line of the error', () => {
    const byStatus = describeToolCall(bash('ncm-cli search song --keyword 借我', {
      status: 'failed',
      result: '│ 有新版本\nerror: unknown command "search"\nmore',
    }))
    expect(byStatus).toEqual({ verb: 'search', label: '搜「借我」', failed: true, detail: 'error: unknown command "search"' })

    const byText = describeToolCall(bash('ncm-cli song lyric --songId X', { result: '[错误] 歌曲不存在' }))
    expect(byText.failed).toBe(true)
    expect(byText.detail).toBe('[错误] 歌曲不存在')

    const byExit = describeToolCall(bash('ncm-cli user info', {
      result: 'not logged in\n\n<bash_metadata>\nExit code: 1\n</bash_metadata>',
    }))
    expect(byExit).toEqual({ verb: 'command', label: 'user info', failed: true, detail: 'not logged in' })
  })

  it('a call without a result is in flight: no detail', () => {
    expect(describeToolCall(bash('ncm-cli search song --keyword 周杰伦', { status: 'executing' }))).toEqual({
      verb: 'search',
      label: '搜「周杰伦」',
    })
  })

  it('doing labels are present tense; no command yet = thinking', () => {
    expect(describeHostDoing(bash('ncm-cli search song --keyword 周杰伦'))).toEqual({ kind: 'search', label: '在搜「周杰伦」' })
    expect(describeHostDoing(bash('ncm-cli song lyric --songId X'))).toEqual({ kind: 'lyric', label: '在翻歌词' })
    expect(describeHostDoing({ id: 'x', toolName: 'bash', arguments: {} })).toEqual({ kind: 'thinking', label: '在想' })
    expect(describeHostDoing(bash('cat > /m/programme-inbox.json <<EOF\n{"entries":[{"title":"a - b"},{"title":"c - d"},{"title":"e - f"}]}\nEOF')))
      .toEqual({ kind: 'queue', label: '排进了 3 首' })
  })
})

describe('projectHostLog', () => {
  const radioUser = (id: string, content: string, timestamp = 1): HostLogMessage => ({
    id, role: 'user', content, timestamp, source: 'radio', origin: { source: 'radio' },
  })

  it('tells the wake prompts apart by their real rendered text', () => {
    const log = projectHostLog([
      radioUser('m1', renderRadioOpenPrompt(renderOptions('凌晨夜晚,专注'))),
      radioUser('m2', renderRadioCurationPrompt(renderOptions('凌晨夜晚,专注'))),
      radioUser('m3', renderRadioTalkPrompt({ ...renderOptions('凌晨夜晚,专注'), message: '来点 <周杰伦>' })),
      { id: 'm4', role: 'user', content: '放点轻音乐', timestamp: 4 },
    ])
    expect(log.rows).toEqual([
      { kind: 'nudge', id: 'm1', at: 1, text: '换了方向:凌晨夜晚,专注' },
      { kind: 'nudge', id: 'm2', at: 1, text: '叫他补歌单' },
      { kind: 'you', id: 'm3', at: 1, text: '来点 <周杰伦>' },
      { kind: 'you', id: 'm4', at: 4, text: '放点轻音乐' },
    ])
    expect(log).toMatchObject({ absent: false, truncated: false })
  })

  it('assistant text becomes host rows, tool calls become cards, in turn order, with stable ids', () => {
    const search = bash('ncm-cli search song --keyword 晴天', { id: 't1', result: SEARCH_STDOUT })
    const message: HostLogMessage = {
      id: 'a1',
      role: 'assistant',
      content: '先找找。这批走安静路线。',
      timestamp: 10,
      toolCalls: [search],
      contentParts: [
        { type: 'text', content: '先找找。' },
        { type: 'tool-call', toolCalls: [{ id: 't1', toolName: 'bash', arguments: search.arguments, status: 'executing' }] },
        { type: 'text', content: '这批走安静路线。' },
      ],
    }
    const first = projectHostLog([message])
    expect(first.rows.map(row => [row.kind, row.id])).toEqual([
      ['host', 'a1:text:0'],
      ['card', 'a1:tool:t1'],
      ['host', 'a1:text:1'],
    ])
    expect(first.rows[1]).toMatchObject({ detail: '272 首,选了「想你就写信 (Live)」' })
    expect(projectHostLog([message])).toEqual(first)
  })

  it('reads tool calls that only live on steps, and skips empty assistant text', () => {
    const log = projectHostLog([{
      id: 'a2',
      role: 'assistant',
      content: '   ',
      timestamp: 5,
      steps: [{ toolCallId: 's1', toolCall: bash('ncm-cli song lyric --songId X', { id: 's1', status: undefined }), result: '{"data":{"noLyric":true}}' }],
    }])
    expect(log.rows).toEqual([{ kind: 'card', id: 'a2:tool:s1', at: 5, verb: 'lyric', label: '翻歌词', detail: '没有歌词' }])
  })

  it('keeps only the tail and says so', () => {
    const messages = Array.from({ length: 70 }, (_, index): HostLogMessage => ({
      id: `u${index}`, role: 'user', content: `第 ${index} 句`, timestamp: index,
    }))
    const log = projectHostLog(messages)
    expect(log.rows).toHaveLength(60)
    expect(log.rows[0]).toMatchObject({ id: 'u10' })
    expect(log.truncated).toBe(true)
    expect(projectHostLog(messages, { limit: 5 }).rows.map(row => row.id)).toEqual(['u65', 'u66', 'u67', 'u68', 'u69'])
  })

  it('empty or odd input is an empty log, never a throw', () => {
    expect(projectHostLog([])).toEqual({ rows: [], absent: false, truncated: false })
    expect(projectHostLog(null)).toEqual({ rows: [], absent: false, truncated: false })
    expect(projectHostLog([null as unknown as HostLogMessage, { id: 'x', role: 'system', content: 'hi' }]).rows).toEqual([])
  })
})
