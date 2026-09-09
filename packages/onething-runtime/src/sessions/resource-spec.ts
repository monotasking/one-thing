/**
 * K1 —— 第一份真的自述:会话(`docs/design/atom-2026-09.md` §9 K1
 * 「`session:` 作为第一个 scheme(读面 / 命令面 / 账本已齐)」)。
 *
 * 选它当第一个不是因为它简单,而是因为它**三样都齐**:读面(`sessionReads`,
 * 返回 readonly)、命令面(`sessionCommands`,12 条消息命令 + `patchSession`)、
 * 事件账本(`events.jsonl`)。§3 那张表里 `session:` 那三行的「差什么」全都是
 * 「就是它,挂到 `ResourceSpec` 上」—— 这只文件就是那次挂载。
 *
 * ── 为什么住在产品层,而且只有数据 ─────────────────────────────────────────
 * 自述是**值**:它说这种资源有哪些读法、哪些做法、会发哪些事件。实现(读走哪个
 * 读面、做走哪条命令)住在装配层(`@onething/backend/wiring/resource/`),因为那
 * 才是够得着脊柱的地方。两半分开的好处在 §8 演练里已经写过:接一个邮箱 =
 * 「一份自述 + 一份驱动 + 一行注册」,core 零改动;会话这一份必须是同一个形状,
 * 否则第一个真 scheme 就已经是个特例。
 *
 * 这只文件因此**不许** import `@onething/backend`(架构边界测试会查),也不 import
 * 任何 store —— 它连 `ChatSession` 的类型都不需要。
 *
 * ── 为什么没有 `send` ──────────────────────────────────────────────────────
 * 「往一条会话里发一条消息」在今天有两条真实通路,两条都不是一两行:协作那条
 * (`toolkit/builtin/send-message.ts` → `speakIntoCollabRoom`)**要求这条会话有房**
 * ——普通聊天会话调它得到的是 `COLLAB_SAY_REFUSED_NO_ROOM`;引擎那条
 * (`command:send-message`)带着「目标空闲就起一个回合 / 目标忙就降级成 steer /
 * 只投递不触发」的三态矩阵(插件 `api.sendMessage` 那一套)与一整套跳数与频率闸。
 * 把其中任何一条塞进 K1,得到的都不是「一条做法」,而是把协作或引擎整棵树拖进
 * 第一个 scheme 的自述里。留账:`send` 归 K2/K3,它值一次单独的设计。
 *
 * ── K2c-1:域退成投影,自述先长出那几条做法 ──────────────────────────────────
 * `docs/design/atom-2026-09.md` §4「RPC 域」那一行要的是「24 个手写域逐个退成
 * 投影」。第一批退的是 `sessions` 域的**写面**七条(`rename` /
 * `updateWorkingDirectory` / `updatePin` / `updateArchived` / `updateModel` /
 * `updateAgent` / `removeMessage`),所以这里补上后五条做法与它们的事件。
 *
 * **为什么这一批只有做法,一条读法都没加**:五条读面(`get` / `getMessages` /
 * `getMessagesPage` / `getUserMarkers` / `getSegments` / `getTokenUsage`)原定同批
 * 退成 `reads`,施工时量出三条硬伤,都不在自述这一层,而在管线上——
 *   ① `OutputBudget` 会截断:读的结果经 `ResourceTool` 投影成 `JSON.stringify(v,
 *      null, 2)`,默认预算 4000 行 / 256 KB。真店实测(2026-09-09,483 条会话)
 *      一页 20 条消息 = 358 – 10 497 行 / 10 KB – 15.9 MB,整份抄本 915 – 54 838 行
 *      / 0.03 – 48.6 MB —— 一页就能越界,整份必越界,而越界之后交给壳的是一段带
 *      `<truncation>` 的文本,不是那一页消息;
 *   ② `Outcome.ok` 只装得下 `Result`(文本),把它折回域信封要 `JSON.parse` 一遍,
 *      多一次全量序列化往返,且 `undefined` 会在往返里消失;
 *   ③ 管线每跑完一次就落一条 `tool/audit`(无发起会话的那一档是**同步**
 *      `appendFileSync` 到 `<store>/audit/resource.jsonl`)—— 那本账的流量假设写在
 *      `wiring/toolkit/audit-sink.ts` 上:「人点一次按钮 / 一次调度」量级,不是
 *      界面每翻一页、每刷一次读数。
 * 写面没有这三条(回执是 `{success}` 两三个字段,而按钮是人点的),所以第一批
 * 只退写面。读面要退,先要给「读」一条能装结构化值、且不进审计账的路 —— 那是
 * 一次机制拍板,不是一次接线,留账给 K2c-2。
 *
 * ── 为什么没有 `appendSystemMessage` ───────────────────────────────────────
 * 它对应域的 `addSystemMessage`,效果类只能是 `session_message`(往会话里写一条
 * 消息)。而 `core/permission/permission-policy.ts` 的 `SILENT_EFFECT_KINDS` 今天
 * 只有 `read` / `ui_change`,`session_message` 落在 ask 那一支(那只文件的注释自己
 * 写着这四类「今天真会弹卡」)—— 于是同一个「/files 往会话里补一条系统消息」的
 * 动作,退成投影之后会当场多出一张权限卡。那是用户可感知的行为变化,归拍板,
 * 不归一次接线单,所以这一条不进第一批。
 */

import type { JsonSchema, ResourceSpec } from '@onething/core/resource'

/** 一条会话的元数据形状(`get` 的结果 / `current` 状态共用同一份 schema)。 */
const SESSION_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string', description: 'The session name shown in the sidebar.' },
    workingDirectory: { type: 'string', description: 'Sandbox root for this session, if any.' },
    createdAt: { type: 'number' },
    messageCount: { type: 'number' },
  },
  required: ['id', 'title', 'createdAt', 'messageCount'],
}

export const SESSION_RESOURCE_SCHEME = 'session'

export const sessionResourceSpec: ResourceSpec = {
  scheme: SESSION_RESOURCE_SCHEME,
  title: 'Sessions',
  reads: {
    /** 元数据,**不带消息** —— 一份会话的抄本动辄几 MB,读一句标题不该拖着它走。 */
    get: {
      title: 'Read the session metadata (no messages)',
      query: { type: 'object', properties: {}, required: [] },
      result: SESSION_SUMMARY_SCHEMA,
    },
    messages: {
      title: 'Read one page of messages, newest last',
      query: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many messages to return (default 20).' },
          before: { type: 'string', description: 'Return the page that ends just before this message id.' },
        },
        required: [],
      },
      result: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            role: { type: 'string' },
            preview: { type: 'string', description: 'Plain-text preview, collapsed to one line.' },
            createdAt: { type: 'number' },
          },
        },
      },
    },
  },
  ops: {
    /**
     * 七条做法的 `effects` 都是**空数组**,这是想清楚的,不是省事:效果表管的是
     * 「这次调用会不会碰到人不知道的东西」(写盘、跑命令、连网、动系统能力)。
     * 改一条会话自己的名字或工作目录,主体本来就拥有这条会话 —— 为它弹一张权限卡
     * 是把审批变成噪音(与 `session_spawn` 从 ask 改回 silent 那次复盘同一条判据)。
     * **空效果不等于不留痕迹**:它照样落 `tool/audit`、照样发事件。
     */
    rename: {
      title: 'Rename the session',
      params: {
        type: 'object',
        properties: { title: { type: 'string', description: 'The new name.' } },
        required: ['title'],
      },
      effects: [],
      home: 'core',
      entity: 'session',
      keymap: true,
      describe: params => `rename to ${String((params as { title?: unknown }).title ?? '')}`,
    },
    setWorkingDirectory: {
      title: 'Point the session at a working directory',
      params: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of the project directory.' } },
        required: ['path'],
      },
      effects: [],
      home: 'core',
      entity: 'session',
      describe: params => `work in ${String((params as { path?: unknown }).path ?? '')}`,
    },
    setPinned: {
      title: 'Pin or unpin the session in the sidebar',
      params: {
        type: 'object',
        properties: { pinned: { type: 'boolean', description: 'True to pin, false to unpin.' } },
        required: ['pinned'],
      },
      effects: [],
      home: 'core',
      entity: 'session',
      keymap: true,
      describe: params => ((params as { pinned?: unknown }).pinned ? 'pin the session' : 'unpin the session'),
    },
    setArchived: {
      title: 'Archive or restore the session',
      params: {
        type: 'object',
        properties: {
          archived: { type: 'boolean', description: 'True to archive, false to restore.' },
          /**
           * 何时归档的。**不收 `null`**:域那一侧的契约是 `number | null`,而
           * 「清掉这个时刻」与「没说」在仓那一层是同一件事(`archivedAt?: number`),
           * 所以 `null` 在适配器里折成缺席,自述里不留一格只有一个调用方看得懂的
           * 空值语义(一格 `type: ['number','null']` 还会让每个读这份自述的出口
           * ——命令面板、MCP 出口——都得先解释它)。
           */
          archivedAt: { type: 'number', description: 'When it was archived (epoch ms).' },
        },
        required: ['archived'],
      },
      effects: [],
      home: 'core',
      entity: 'session',
      describe: params => ((params as { archived?: unknown }).archived ? 'archive the session' : 'restore the session'),
    },
    setModel: {
      title: 'Point the session at a provider and model',
      params: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'Provider id, e.g. "deepseek".' },
          model: { type: 'string', description: 'Model id as the provider names it.' },
        },
        required: ['provider', 'model'],
      },
      effects: [],
      home: 'core',
      entity: 'session',
      describe: params => {
        const value = params as { provider?: unknown; model?: unknown }
        return `use ${String(value.provider ?? '')}/${String(value.model ?? '')}`
      },
    },
    setAgent: {
      title: 'Bind the session to an agent',
      params: {
        type: 'object',
        properties: {
          /**
           * 缺席 / 空串 = 回到默认 agent。这不是「不改」——「不改」的表达方式是
           * 不发这条做法。
           */
          agentId: { type: 'string', description: 'Agent id; absent or empty means the default agent.' },
        },
        required: [],
      },
      effects: [],
      home: 'core',
      entity: 'session',
      describe: params => `bind agent ${String((params as { agentId?: unknown }).agentId ?? '(default)')}`,
    },
    removeMessage: {
      title: 'Remove one message from the session',
      params: {
        type: 'object',
        properties: { messageId: { type: 'string', description: 'The message to remove.' } },
        required: ['messageId'],
      },
      /**
       * **空效果,而且这一条是留账不是结论**(K2c-1)。删一条消息不是改一格会话
       * 元数据:它动的是账本本身。效果表(`core/toolkit/effects.ts`)十五类里没有
       * 一类装得下它 —— `session_message` 说的是「往会话里写一条消息」,不是删;
       * 硬套过去会让「补一条系统消息」与「删掉一条消息」在授权上变成同一件事。
       *
       * 今天填空数组,是因为这条做法的**唯一调用方是域**(壳上那个删除按钮),
       * 而域这一路今天不弹卡 —— 空数组保住的是「退成投影不改行为」。等效果表为
       * 它开一格(或裁定它归 `session_message`),这里改一行,授权自然跟上。
       */
      effects: [],
      home: 'core',
      entity: 'message',
      describe: params => `remove message ${String((params as { messageId?: unknown }).messageId ?? '')}`,
    },
  },
  events: {
    renamed: {
      title: 'The session was renamed',
      payload: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    },
    workingDirectoryChanged: {
      title: 'The working directory of the session changed',
      payload: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    pinned: {
      title: 'The session was pinned or unpinned',
      payload: { type: 'object', properties: { pinned: { type: 'boolean' } }, required: ['pinned'] },
    },
    archived: {
      title: 'The session was archived or restored',
      payload: { type: 'object', properties: { archived: { type: 'boolean' } }, required: ['archived'] },
    },
    modelChanged: {
      title: 'The session was pointed at another model',
      payload: {
        type: 'object',
        properties: { provider: { type: 'string' }, model: { type: 'string' } },
        required: ['provider', 'model'],
      },
    },
    agentChanged: {
      title: 'The session was bound to another agent',
      payload: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
    },
    messageRemoved: {
      title: 'A message was removed from the session',
      payload: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] },
    },
  },
  /**
   * K1 **只声明不投影**:这一格说的是「`get` 这条读法值得在每一回合喂进
   * `<context-update>` 尾块」,而真的把它接到提示词双通道上是 K4 的事(§4「提示词」
   * 那一行 = 变量系统,不另立)。现在写下来,是因为「哪些状态值得主动喂」是**自述**
   * 的一部分 —— 等到接的时候再补,那一刻就会有人想在提示词那一侧按 scheme 枚举。
   */
  state: {
    current: {
      title: 'The session this turn is happening in',
      schema: SESSION_SUMMARY_SCHEMA,
      volatility: 'turn',
    },
  },
}
