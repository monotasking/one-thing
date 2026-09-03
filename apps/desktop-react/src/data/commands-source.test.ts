import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHARED_SLASH_COMMANDS } from '@onething/core/slash-commands'
import { configureCommandsPort } from './commands-port'
import { configureSessionsPort } from './sessions-port'
import {
  BUILTIN_COMMANDS,
  commandTokenOf,
  executeCommand,
  findCommand,
  mergeCommands,
  parseDraftCommand,
  RUNNABLE_BUILTIN_IDS,
  toPluginCommand,
  useCommandsSource,
} from './commands-source'
import type { CommandEntry } from './commands-source'
import { DEV_COMMANDS } from '../composer/data'
import { useStageStore } from '../stage/store'

/**
 * 斜杠命令(D4 波二)。三件事:
 *  ① **对账** —— 屏幕上那张表与 core 的注册表逐条相等(照
 *     `packages/renderer/services/commands/__tests__/index.test.ts` 的先例:
 *     id 全集相等。表在两处各写一份就会漂,这条断言是唯一的防线);
 *  ② 判据 —— 「这句话是不是一条命令」;
 *  ③ 三类执行各一例 —— 只插文本 / 动作 / 插件。
 */

/* ── 假端口:两条命令口 + 一条会话写面 ────────────────────────────────── */

interface Ran {
  name: string
  args: string
  sessionId: string
}

const pluginRuns: Ran[] = []
const compacted: string[] = []
const cds: { sessionId: string; dir: string | null }[] = []
let starts = 0
let startAnswer: string | undefined = 'created-1'
let cdOk = true

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  pluginRuns.length = 0
  compacted.length = 0
  cds.length = 0
  starts = 0
  startAnswer = 'created-1'
  cdOk = true
  useCommandsSource.getState().reset()

  configureCommandsPort({
    ready: async () => undefined,
    listPluginCommands: async () => ({
      success: true,
      commands: [
        { id: 'note:save', name: '/note', description: '记一笔', usage: '/note <文字>' },
        // id 与内置撞了:插件顶不掉 `/new`。
        { id: 'new', name: '/new', description: '插件冒充的', usage: '/new' },
      ],
    }),
    executePluginCommand: async (name, args, sessionId) => {
      pluginRuns.push({ name, args, sessionId })
      return { success: true, message: '记好了' }
    },
    compactContext: async (sessionId) => {
      compacted.push(sessionId)
      return { success: true }
    },
  })

  configureSessionsPort({
    ready: async () => undefined,
    listMeta: async () => ({ success: true, sessions: [] }),
    getSegments: async () => ({ success: true, segments: [] }),
    getMessagesPage: async () => ({ success: true, messages: [] }),
    getUserMarkers: async () => ({ success: true, markers: [] }),
    create: async () => ({ success: false, error: 'not used here' }),
    updateWorkingDirectory: async (sessionId, workingDirectory) => {
      cds.push({ sessionId, dir: workingDirectory })
      return cdOk ? { success: true } : { success: false, error: '目录不存在' }
    },
    updatePin: async () => ({ success: true }),
    onSessionEvent: () => () => undefined,
    onSessionLifecycle: () => () => undefined,
  })
})

afterEach(() => {
  configureCommandsPort(undefined)
  configureSessionsPort(undefined)
  useCommandsSource.getState().reset()
})

const ctx = (sessionId = 's1') => ({
  sessionId,
  startSession: async () => {
    starts += 1
    return startAnswer
  },
})

const builtin = (id: string): CommandEntry => {
  const entry = BUILTIN_COMMANDS.find((row) => row.id === id)
  if (!entry) throw new Error(`no builtin ${id}`)
  return entry
}

/* ── ① 对账 ───────────────────────────────────────────────────────────── */

describe('表与 core 的注册表对账', () => {
  it('内置那一半的 id 全集**逐条相等**,一条不多一条不少', () => {
    expect(BUILTIN_COMMANDS.map((entry) => entry.id)).toEqual(
      SHARED_SLASH_COMMANDS.map((command) => command.id),
    )
  })

  it('屏幕上那几个字直接来自注册表 —— 壳一个都不现造', () => {
    for (const command of SHARED_SLASH_COMMANDS) {
      const entry = builtin(command.id)
      expect(entry.name).toBe(command.displayLabel)
      expect(entry.desc).toBe(command.description)
      expect(entry.usage).toBe(command.usage)
      expect(entry.insertText).toBe(command.insertText)
      expect(entry.allowArgs).toBe(command.allowArgs === true)
    }
  })

  it('留账在表上写着:内置七条里壳只执行三条,其余四条只插文本', async () => {
    expect([...RUNNABLE_BUILTIN_IDS]).toEqual(['new', 'compact', 'cd'])
    const notRunnable = BUILTIN_COMMANDS.filter(
      (entry) => !RUNNABLE_BUILTIN_IDS.includes(entry.id as (typeof RUNNABLE_BUILTIN_IDS)[number]),
    )
    expect(notRunnable.map((entry) => entry.id)).toEqual([
      'goal',
      'kegel',
      'pomodoro',
      'practice-stop',
    ])
    for (const entry of notRunnable) {
      expect(await executeCommand(entry, '', ctx())).toEqual({ kind: 'sendAsText' })
    }
  })

  it('拉插件命令:并进表里,**同名以内置为准**,dev 那条排最后', async () => {
    await useCommandsSource.getState().ensurePluginCommands()
    const merged = mergeCommands(
      BUILTIN_COMMANDS,
      useCommandsSource.getState().pluginCommands,
      DEV_COMMANDS,
    )
    // 插件那条冒充的 `/new` 被挡在外面,真的 `/new` 还是内置那条。
    expect(merged.filter((entry) => commandTokenOf(entry) === 'new')).toHaveLength(1)
    expect(findCommand(merged, 'new')?.kind).toBe('builtin')
    expect(findCommand(merged, 'note')?.kind).toBe('plugin')
    expect(merged.at(-1)?.id).toBe('ask-demo')
  })

  /*
   * 08-31 真机走查:敲 `/`,抽屉里出现 `/ask-demo` —— 一条只为「ask 形态还没有真
   * 产地」而存在的 dev 扳机。用户看见它只会当成一个坏掉的功能。
   * 单测自己跑在 dev 形里(vitest 的 `import.meta.env.DEV` 恒真),所以生产形
   * 必须显式传进来测,否则这条门只测得到一半。
   */
  it('生产形的命令表里一条 dev 命令都没有', async () => {
    await useCommandsSource.getState().ensurePluginCommands()
    const plugin = useCommandsSource.getState().pluginCommands
    const prod = mergeCommands(BUILTIN_COMMANDS, plugin, DEV_COMMANDS, false)

    expect(prod.some((entry) => entry.kind === 'dev')).toBe(false)
    expect(findCommand(prod, 'ask-demo')).toBeUndefined()
    // 挡掉的**只有** dev 那些:内置与插件一条不少。
    expect(prod).toEqual(
      mergeCommands(BUILTIN_COMMANDS, plugin, DEV_COMMANDS, true).filter(
        (entry) => entry.kind !== 'dev',
      ),
    )
  })

  it('判据是命令自报的 kind,不是它从第几个参数传进来的', () => {
    const smuggled: CommandEntry[] = [{ ...DEV_COMMANDS[0], id: 'smuggled', name: '/smuggled' }]
    // 一条 dev 命令混进插件表里,照样挡掉。
    expect(mergeCommands(BUILTIN_COMMANDS, smuggled, [], false)).toEqual(
      mergeCommands(BUILTIN_COMMANDS, [], [], false),
    )
  })

  it('插件读面失败:静默降级成只剩内置,不抛也不弹', async () => {
    configureCommandsPort({
      ready: async () => undefined,
      listPluginCommands: async () => {
        throw new Error('desktop host only')
      },
      executePluginCommand: async () => ({ success: false }),
      compactContext: async () => ({ success: false }),
    })
    await useCommandsSource.getState().ensurePluginCommands()
    expect(useCommandsSource.getState().pluginStatus).toBe('error')
    expect(useCommandsSource.getState().pluginCommands).toEqual([])
  })

  it('插件命令的原名一个字都不改写(后端按它查表)', () => {
    expect(
      toPluginCommand({ id: 'x', name: '/note', description: 'd', usage: '/note' }).name,
    ).toBe('/note')
    // 后端偶尔不带斜杠 —— 补上,但**只补这一处**,查表用的仍是这个原名。
    expect(toPluginCommand({ id: 'x', name: 'note', description: 'd', usage: '' }).name).toBe(
      '/note',
    )
  })
})

/* ── ② 判据 ───────────────────────────────────────────────────────────── */

describe('这句话是不是一条命令', () => {
  it('整段就是 `/词` 或 `/词 <参数>` 才算', () => {
    expect(parseDraftCommand('/new')).toEqual({ token: 'new', args: '' })
    expect(parseDraftCommand('  /cd  ~/work  ')).toEqual({ token: 'cd', args: '~/work' })
    expect(parseDraftCommand('/practice-stop')).toEqual({ token: 'practice-stop', args: '' })
  })

  it('句中的斜杠不是命令 —— 「看看 /new 那条」是人在说话', () => {
    expect(parseDraftCommand('看看 /new 那条')).toBeNull()
    expect(parseDraftCommand('a/b')).toBeNull()
    expect(parseDraftCommand('')).toBeNull()
    expect(parseDraftCommand('/')).toBeNull()
  })

  it('多行的一段整段都不算命令 —— 后面那几行不该被当成参数打进去', () => {
    expect(parseDraftCommand('/cd /a/b\n还有别的话')).toBeNull()
  })
})

/* ── ③ 三类执行 ───────────────────────────────────────────────────────── */

describe('① 只插文本那一类:壳不执行,原样当消息发出去', () => {
  it('/goal 带一句话也只是 sendAsText —— 不报错、不吞掉', async () => {
    expect(await executeCommand(builtin('goal'), '把徽标那处改了', ctx())).toEqual({
      kind: 'sendAsText',
    })
  })
})

describe('② 动作那一类', () => {
  it('/new:走建会话的唯一编排点,恰好一次', async () => {
    expect(await executeCommand(builtin('new'), '', ctx(''))).toEqual({ kind: 'done' })
    expect(starts).toBe(1)
  })

  it('/new 带参数是用法错 —— 注册表说它不收参数', async () => {
    expect(await executeCommand(builtin('new'), 'session', ctx())).toEqual({
      kind: 'failed',
      error: '用法:/new',
    })
    expect(starts).toBe(0)
  })

  it('/new 建不成:失败但**不带话** —— 编排点已经说过一次了,不加第二条提示', async () => {
    startAnswer = undefined
    expect(await executeCommand(builtin('new'), '', ctx(''))).toEqual({ kind: 'failed', error: '' })
  })

  it('/compact:往会话命令总线上发一封信,只发不等', async () => {
    expect(await executeCommand(builtin('compact'), '', ctx('s1'))).toEqual({
      kind: 'done',
      message: '已请求压缩上下文',
    })
    expect(compacted).toEqual(['s1'])
  })

  it('/compact 没有会话:说清楚要先有一条,不发空信', async () => {
    expect(await executeCommand(builtin('compact'), '', ctx(''))).toEqual({
      kind: 'failed',
      error: '这条命令需要先有一条会话',
    })
    expect(compacted).toEqual([])
  })

  it('/cd <路径>:参数直接打进会话的工作目录写面', async () => {
    expect(await executeCommand(builtin('cd'), '~/work', ctx('s1'))).toEqual({
      kind: 'done',
      message: '工作目录已改为 ~/work',
    })
    expect(cds).toEqual([{ sessionId: 's1', dir: '~/work' }])
  })

  it('/cd 不带路径:念一句用法就完 —— **不开原生目录对话框**(壳没有 dialog 桥)', async () => {
    expect(await executeCommand(builtin('cd'), '', ctx('s1'))).toEqual({
      kind: 'failed',
      error: '用法:/cd <path>',
    })
    expect(cds).toEqual([])
  })

  it('/cd 后端不认:原话原样报出来,不换成一句自己编的', async () => {
    cdOk = false
    expect(await executeCommand(builtin('cd'), '/nope', ctx('s1'))).toEqual({
      kind: 'failed',
      error: '目录不存在',
    })
  })
})

describe('③ 插件那一类', () => {
  const note = toPluginCommand({
    id: 'note:save',
    name: '/note',
    description: '记一笔',
    usage: '/note <文字>',
  })

  it('原名 + 参数 + 会话三样原样交给后端;后端那句话原样回来', async () => {
    expect(await executeCommand(note, '买牛奶', ctx('s1'))).toEqual({
      kind: 'done',
      message: '记好了',
    })
    expect(pluginRuns).toEqual([{ name: '/note', args: '买牛奶', sessionId: 's1' }])
  })

  it('没有会话不发 —— 插件命令在主进程里跑,一个不存在的会话 id 过不去', async () => {
    expect(await executeCommand(note, '买牛奶', ctx(''))).toEqual({
      kind: 'failed',
      error: '这条命令需要先有一条会话',
    })
    expect(pluginRuns).toEqual([])
  })

  it('后端拒绝(例如联网宿主没装配插件管理器):原话报出来,壳不替它编一句', async () => {
    configureCommandsPort({
      ready: async () => undefined,
      listPluginCommands: async () => ({ success: true, commands: [] }),
      executePluginCommand: async () => ({
        success: false,
        error: 'Plugin commands run on the desktop host only',
      }),
      compactContext: async () => ({ success: true }),
    })
    expect(await executeCommand(note, '', ctx('s1'))).toEqual({
      kind: 'failed',
      error: 'Plugin commands run on the desktop host only',
    })
  })
})
