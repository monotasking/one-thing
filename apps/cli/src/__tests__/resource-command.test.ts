/**
 * `onething resource` —— 排版与派发(原子 K4-b,`docs/design/atom-2026-09.md` §4
 * 「deeplink / CLI」)。
 *
 * 与 `trace-format.test.ts` 同一条:命令那一层的全部内容是「拼参数 → 发一支
 * daemon 方法 → 排版」,所以测的是**纯函数 + 一只假客户端**,不起 daemon。
 * daemon 那四支方法真的在不在表上,由 `resource-daemon.test.ts` 钉。
 *
 * 四件事:
 *  ① `--json` 打的与 RPC 投影**逐字相同**(不是第二份事实);
 *  ② 缺省人话表按动词分节,而且只印人要的那几格(不打 JSON Schema 正文);
 *  ③ 非 `ok` 的读 / 做退出码是 1 —— `&& 下一条` 要停得下来;
 *  ④ `--query` / `--params` 写坏了当场抛,不是被当成空参数悄悄跑掉。
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  ListResourcesResponse,
  ResourceOutcomeView,
  ResourceReadView,
  SerializedResourceSpec,
} from '@shared/ipc/resources.js'
import {
  formatOutcomeView,
  formatReadView,
  formatResourceList,
  formatResourceSpec,
  parseJsonArgument,
  resourceCommand,
} from '../resource-command.js'

const SPEC: SerializedResourceSpec = {
  scheme: 'session',
  title: 'Sessions',
  reads: {
    get: { title: 'Session summary', query: { type: 'object' }, result: { type: 'object' } },
    record: { title: 'Full record', query: { type: 'object' }, result: { type: 'object' } },
  },
  ops: {
    focus: { title: 'Focus it', params: { type: 'object' }, effects: ['ui_change'], home: 'shell' },
    remove: {
      title: 'Delete it',
      params: { type: 'object' },
      effects: ['session_destructive'],
      home: 'core',
      whenGated: true,
    },
    rename: { title: 'Rename it', params: { type: 'object' }, effects: [], home: 'core' },
  },
  events: {
    renamed: { title: 'Renamed', payload: { type: 'object' } },
  },
  state: {
    current: { title: 'Current session', schema: { type: 'object' }, volatility: 'turn' },
  },
}

/** 一只只会答固定值的客户端。记下方法与参数,好断言「CLI 递过去的是什么」。 */
function fakeClient(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; params?: unknown }> = []
  return {
    calls,
    client: {
      request: vi.fn(async (method: never, params?: unknown) => {
        calls.push({ method: method as unknown as string, params })
        return answers[method as unknown as string]
      }),
    },
  }
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  return { lines, restore: () => { process.stdout.write = original } }
}

async function run(
  command: string,
  rest: string[],
  options: Parameters<typeof resourceCommand>[2],
  answers: Record<string, unknown>,
): Promise<{ code: number; out: string; calls: Array<{ method: string; params?: unknown }> }> {
  const { calls, client } = fakeClient(answers)
  const captured = captureStdout()
  try {
    const code = await resourceCommand(command, rest, options, client)
    return { code, out: captured.lines.join(''), calls }
  } finally {
    captured.restore()
  }
}

describe('onething resource —— 排版', () => {
  it('list:两列,不是 JSON', () => {
    const response: ListResourcesResponse = {
      schemes: [
        { scheme: 'dir', title: 'Folders' },
        { scheme: 'session', title: 'Sessions' },
      ],
    }
    expect(formatResourceList(response)).toBe('dir      Folders\nsession  Sessions')
    // 一台什么都没登记的宿主要说得出「没有」,而不是打一行空白。
    expect(formatResourceList({ schemes: [] })).toBe('(no resources registered)')
  })

  it('describe:按动词分节,做法带效果 / 家 / 场子闸,而 schema 正文不进人话表', () => {
    const text = formatResourceSpec(SPEC)
    expect(text.split('\n')[0]).toBe('session — Sessions')
    expect(text).toContain('READS')
    expect(text).toContain('get     Session summary')
    expect(text).toContain('OPS')
    // 三条补充各自出现在自己那一行上。
    expect(text).toContain('focus   Focus it (ui_change; needs a window)')
    expect(text).toContain('remove  Delete it (session_destructive; scene-gated)')
    // 没有效果的做法不带空括号。
    expect(text).toContain('rename  Rename it')
    expect(text).not.toContain('rename  Rename it (')
    expect(text).toContain('EVENTS')
    expect(text).toContain('STATE')
    expect(text).toContain('current  Current session (turn)')
    // 人话表不打 schema 正文 —— 那是给机器读的,要它就 --json。
    expect(text).not.toContain('"type"')
  })

  it('describe:空的一节说「(none)」,不是消失', () => {
    const text = formatResourceSpec({ ...SPEC, events: {}, state: undefined })
    expect(text).toContain('EVENTS\n  (none)')
    // 没有 state 的自述压根不该长出那一节。
    expect(text).not.toContain('STATE')
  })

  it('read / do:四支与五支各有一句人话,`ok` 的做法打的是管线交给模型的那段文本', () => {
    expect(formatReadView({ kind: 'ok', value: { id: 'a', title: 'x' } }))
      .toBe('{\n  "id": "a",\n  "title": "x"\n}')
    expect(formatReadView({ kind: 'denied', reason: 'not yours' })).toBe('denied: not yours')
    expect(formatReadView({ kind: 'invalid', message: 'no such read' })).toBe('invalid: no such read')
    expect(formatReadView({ kind: 'failed', error: { name: 'SessionNotFoundError', message: 'nope' } }))
      .toBe('failed: SessionNotFoundError: nope')

    expect(formatOutcomeView({ kind: 'ok', text: 'Renamed to "x"' })).toBe('Renamed to "x"')
    expect(formatOutcomeView({ kind: 'aborted', reason: 'timeout', partial: 'half' }))
      .toBe('aborted: timeout\nhalf')
    expect(formatOutcomeView({ kind: 'aborted' })).toBe('aborted')
  })
})

describe('onething resource —— 参数', () => {
  it('--query / --params 缺席是空对象', () => {
    expect(parseJsonArgument(undefined, 'query')).toEqual({})
    expect(parseJsonArgument('  ', 'query')).toEqual({})
    expect(parseJsonArgument('{"limit":20}', 'query')).toEqual({ limit: 20 })
  })

  it('写坏了当场抛 —— 一次打错的引号不该被当成空参数悄悄跑掉', () => {
    expect(() => parseJsonArgument('{limit:20}', 'query')).toThrow(/must be valid JSON/)
    // 顶层不是对象也抛:params 在契约上就是一张表。
    expect(() => parseJsonArgument('[1,2]', 'params')).toThrow(/must be a JSON object/)
    expect(() => parseJsonArgument('"x"', 'params')).toThrow(/must be a JSON object/)
  })
})

describe('onething resource —— 派发', () => {
  it('list 缺省人话、--json 与 RPC 投影逐字相同', async () => {
    const response: ListResourcesResponse = { schemes: [{ scheme: 'session', title: 'Sessions' }] }
    const human = await run('list', [], {}, { 'resource.list': response })
    expect(human.calls).toEqual([{ method: 'resource.list', params: undefined }])
    expect(human.out.trim()).toBe('session  Sessions')

    const json = await run('list', [], { json: true }, { 'resource.list': response })
    expect(JSON.parse(json.out)).toEqual(response)
  })

  it('read 把 --query / --session 原样递下去,`ok` 退出码 0', async () => {
    const view: ResourceReadView = { kind: 'ok', value: { id: 's1' } }
    const result = await run(
      'read',
      ['session:s1', 'get'],
      { query: '{"limit":5}', session: 'origin-1' },
      { 'resource.read': view },
    )
    expect(result.code).toBe(0)
    expect(result.calls[0]).toEqual({
      method: 'resource.read',
      params: { ref: 'session:s1', name: 'get', query: { limit: 5 }, sessionId: 'origin-1' },
    })
  })

  it('read 不给 --session 就**不带**发起坐标(缺席就是缺席,不拿 ref 里那条顶上)', async () => {
    const result = await run('read', ['session:s1', 'get'], {}, {
      'resource.read': { kind: 'ok', value: {} } satisfies ResourceReadView,
    })
    expect(result.calls[0].params).toEqual({ ref: 'session:s1', name: 'get', query: {} })
    expect(result.calls[0].params).not.toHaveProperty('sessionId')
  })

  it('do 被拒 / 失败时退出码是 1 —— `&& 下一条` 要停得下来', async () => {
    const denied: ResourceOutcomeView = { kind: 'denied', reason: 'the user said no' }
    const result = await run('do', ['session:s1', 'remove'], {}, { 'resource.do': denied })
    expect(result.code).toBe(1)
    expect(result.out.trim()).toBe('denied: the user said no')

    const ok = await run('do', ['session:s1', 'rename'], { params: '{"name":"x"}' }, {
      'resource.do': { kind: 'ok', text: 'renamed' } satisfies ResourceOutcomeView,
    })
    expect(ok.code).toBe(0)
    expect(ok.calls[0].params).toMatchObject({ ref: 'session:s1', op: 'rename', params: { name: 'x' } })
  })

  it('缺参数 / 未知子命令都带上 usage —— 错的时候人要看得见正确写法', async () => {
    await expect(run('read', ['session:s1'], {}, {})).rejects.toThrow(/name is required/)
    await expect(run('describe', [], {}, {})).rejects.toThrow(/scheme is required/)
    await expect(run('sing', [], {}, {})).rejects.toThrow(/Unknown resource command: sing/)
    await expect(run('sing', [], {}, {})).rejects.toThrow(/Usage: onething resource/)
  })
})
