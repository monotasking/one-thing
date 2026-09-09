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
 * ── K2c-2:那次拍板做完了,读面这一批跟着退 ────────────────────────────────
 * `ResourceKernel.read` 不再走 `ToolRunner`(`core/resource/read-outcome.ts` 的文件头
 * 是那次修正的全文):读有自己的短路径、返回 `ReadOutcome`(`ok` 装的是**值**)、
 * 不落审计不吃预算。上面那三条硬伤因此一条不剩,`sessions` 域六条读面
 * (`get` / `getMessages` / `getMessagesPage` / `getUserMarkers` / `getSegments` /
 * `getTokenUsage`)退成这份自述的投影,对外契约一个字不改。
 *
 * 自述这一侧的账:补 `markers` / `segments` / `tokenUsage` 三条读法,`messages`
 * 长出分页那四格(整份与一页是**同一条读法**,判据是「说没说分页的话」),
 * `get` 的返回值从摘要改成会话记录 —— 那一条是 K1 口径的推翻,理由写在它自己
 * 那一格上。
 *
 * ── K3-a':资源工具进了目录,于是自述要为「模型也读得到它」负责 ───────────────
 * K3-a 把资源工具放进工具目录(provider 在注册表里 = 那只工具在目录里),这份
 * 自述从此**不再只有界面读**。两处因此改口:
 *
 *   ① `get` 还给摘要,整份记录另立一条 `record`(K2c-2 那半句被推翻,理由写在
 *      `get` 那一格上)—— 合成一条之后模型每问一次「我在哪条会话里」都会拉回整份
 *      抄本再被预算截断;
 *   ② `removeMessage.effects` 从空数组改成 `['session_destructive']`,那是**上界**;
 *      真发给授权者的按主体分档,住在 provider 的 `plan` 里 —— 用户删自己的消息
 *      不问,AI 删必须问。
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

/**
 * 一条会话的元数据形状(`get` 的结果 / `current` 状态共用同一份 schema)。
 *
 * K3-a' 把 `get` 还给它之后又长了四格(`pinned` / `archived` / `model` / `agent`):
 * 那是「这条会话此刻是什么状态」里,读一句标题的人下一句就会问的四件事,而它们
 * 一格都不带抄本。`model` 写成 `provider/model` 一整串 —— 与 `setModel` 那条做法
 * 自己的 `describe` 逐字同形,不为同一件事造两种写法。
 */
const SESSION_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string', description: 'The session name shown in the sidebar.' },
    workingDirectory: { type: 'string', description: 'Sandbox root for this session, if any.' },
    createdAt: { type: 'number' },
    messageCount: { type: 'number' },
    pinned: { type: 'boolean', description: 'Pinned to the top of the sidebar.' },
    archived: { type: 'boolean', description: 'Archived out of the sidebar.' },
    model: { type: 'string', description: 'Which model this session last ran on, as "provider/model".' },
    agent: { type: 'string', description: 'The agent this session is bound to.' },
  },
  required: ['id', 'title', 'createdAt', 'messageCount', 'pinned', 'archived'],
}

/**
 * `state.current` 进提示词的**键集**(K4-a')。
 *
 * ## 它为什么不是 `SESSION_SUMMARY_SCHEMA`
 *
 * `state` 的 schema 就是这格状态进提示词的键集 —— 投影方按这张 `properties` 过滤
 * `read` 交回来的值,没声明的键一格都不进板。所以它与 `get` 的结果**不是别名**,
 * 这里的减法是有意的:
 *
 *   · `messageCount` —— 每回合都在动。变量板整块是**一个** section(`variables`),
 *     尾块的去重按 section 比字节,于是只要这一格在板上,这块板就每回合重发一次。
 *     「这条会话有多少条消息」模型从抄本本身就看得见,为它每回合付几百字节的重复
 *     不成比例。要数,问 `get`。
 *   · `createdAt` —— 不动,但也不该逐回合出现在提示词里:一条会话是什么时候建的
 *     与「这一回合发生在哪条会话里」无关,它是问出来的事实,不是喂进去的事实。
 *
 * 剩下的七格都是「这一回合发生在哪」的一部分,而且**在一条会话的一生里几乎不动**
 * ——这正是它们值得每回合白喂一次的理由。
 *
 * 减法在这里而不在投影方,是「能力自述、别人读表」那条:将来任何一种资源都靠
 * 自己这一格控制自己进提示词的字节,而投影方不认识任何键名。
 */
const SESSION_STATE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string', description: 'The session name shown in the sidebar.' },
    workingDirectory: { type: 'string', description: 'Sandbox root for this session, if any.' },
    pinned: { type: 'boolean', description: 'Pinned to the top of the sidebar.' },
    archived: { type: 'boolean', description: 'Archived out of the sidebar.' },
    model: { type: 'string', description: 'Which model this session last ran on, as "provider/model".' },
    agent: { type: 'string', description: 'The agent this session is bound to.' },
  },
  required: ['id', 'title', 'pinned', 'archived'],
}

/**
 * 一条会话的完整记录(`record` 的结果)。**故意写得松**:它就是这台宿主的
 * `ChatSession`,那份形状的权威在共享契约那一包里,在这里抄一份齐全的等于立刻
 * 有两张会漂移的表。列出来的几格是「每一条会话都一定有」的那几个,其余原样带过。
 */
const SESSION_RECORD_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string', description: 'The session name shown in the sidebar.' },
    workingDirectory: { type: 'string', description: 'Sandbox root for this session, if any.' },
    createdAt: { type: 'number' },
    messages: { type: 'array', description: 'The transcript, as the shell renders it.' },
  },
  required: ['id', 'name'],
}

/**
 * 消息读法的结果:一页消息 + 这一页在整份抄本里的位置。
 *
 * 分页那几格是**可选**的 —— 整份抄本那一支没有「下一页」可言。格名与
 * `GetSessionMessagesPageResponse` 逐字相同。
 */
const MESSAGES_PAGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    messages: { type: 'array', description: 'The messages, oldest first.' },
    nextCursor: { type: 'string', description: 'Ask for the page before this one with it.' },
    backwardsCursor: { type: 'string' },
    hasMoreBefore: { type: 'boolean' },
    hasMoreAfter: { type: 'boolean' },
    totalCount: { type: 'number', description: 'How many messages the whole transcript holds.' },
  },
  required: ['messages'],
}

export const SESSION_RESOURCE_SCHEME = 'session'

export const sessionResourceSpec: ResourceSpec = {
  scheme: SESSION_RESOURCE_SCHEME,
  title: 'Sessions',
  reads: {
    /**
     * 一条会话的摘要 —— **不带消息**。
     *
     * ## 两条读法是两件事,不是一件事的两种详略(K3-a')
     *
     * K1 写的是摘要;K2c-2 把它改成整份记录,理由是「域的 `sessions.get` 契约要
     * `ChatSession`,给界面另开一条读法就是同一件事两条读法」。K3-a' 推翻那半句:
     * 它们本来就**不是**同一件事,判据是「谁问、问来干什么」——
     *
     *   · `get` 是**认领身份**:标题、目录、多少条、钉没钉、归没归档、跑在哪个模型
     *     上。命令面板列一屏会话问它,提示词的 `state.current` 喂的是它,模型想
     *     知道「我在哪条会话里」问的也是它。它必须小到能一屏列一百条。
     *   · `record` 是**取那份记录**:壳要渲染这条会话,它要的就是 `ChatSession`
     *     本人(带 `messages`)。那是一件真实存在的、只有壳需要的事。
     *
     * 合成一条的代价是实测出来的:合并之后模型每问一次「这是哪条会话」都会拉回
     * 整份抄本(真店 0.03 – 48.6 MB),然后被 `OutputBudget` 截成一段带
     * `<truncation>` 的文本 —— 答非所问,还烧掉这一回合的预算。「读者不同、大小
     * 差三个数量级」是两条读法而不是两个参数的判据,与 `messages` 那一格恰好相反
     * (整份与一页读者相同、只差参数,所以它是一条)。
     */
    get: {
      title: 'Read the session summary: who this session is, without the transcript',
      query: { type: 'object', properties: {}, required: [] },
      result: SESSION_SUMMARY_SCHEMA,
    },
    /**
     * 一条会话的完整记录(`ChatSession` 本人,带抄本)。壳渲染一条会话时问它 ——
     * 域的 `sessions.get` 走的就是这一条(它的契约 `SwitchSessionResponse.session`
     * 要的正是 `ChatSession`)。
     *
     * 为什么模型也看得见它:因为它不是秘密,而「一次读多少」有专门的机制管
     * ——`ResourceTool` 那条路过 `OutputBudget`,超了就截断。给读法加一格「只有
     * 界面能调」等于在自述里长出主体判据,那是授权该管的事,不是自述该管的事。
     */
    record: {
      title: 'Read the whole session record, transcript included',
      query: { type: 'object', properties: {}, required: [] },
      result: SESSION_RECORD_SCHEMA,
    },
    /**
     * 消息:**整份或一页,同一条读法**(K2c-2)。
     *
     * 判据只有一条 ——「这次说了分页的话没有」:`cursor` / `anchor` / `limit` /
     * `direction` 四格一个都没给 = 整份抄本(域的 `getMessages`);给了任意一格 =
     * 一页(域的 `getMessagesPage`,它总是至少带一个 `anchor`)。
     *
     * 为什么不拆成两条读法:那样「读这条会话的消息」在自述里会有两个名字,命令
     * 面板、MCP 出口、提示词三处都要各自解释两者的差别,而它们的差别只是参数。
     * 四格的名字与 `GetSessionMessagesPageRequest` 逐字相同 —— 是一次转手不是翻译。
     */
    messages: {
      title: 'Read the messages of the session: the whole transcript, or one page',
      query: {
        type: 'object',
        properties: {
          /**
           * K3-a':缺省 20、一次最多 100 —— 这句话是**写给模型看的**,也只对模型
           * 生效(provider 在读的时候按主体夹,见它那只 `messages`)。壳不读
           * description,它读的是 `GetSessionMessagesPageRequest` 那份契约,而那一
           * 条的分页由 pager 自己的上限管(300),本单一格不动。
           */
          limit: { type: 'number', description: 'How many messages one page holds. Default 20, at most 100.' },
          cursor: { type: 'string', description: 'Continue from a cursor a previous page handed back.' },
          direction: {
            type: 'string',
            enum: ['older', 'newer'],
            description: 'Which way to walk from the cursor (default older).',
          },
          anchor: {
            description: '"tail" for the newest page, or { messageId | seq, before, after } to centre on one message.',
          },
        },
        required: [],
      },
      result: MESSAGES_PAGE_SCHEMA,
    },
    /** 用户消息的锚点(会话目录 / 跳转用)。 */
    markers: {
      title: 'Read the user-message markers of the session',
      query: { type: 'object', properties: {}, required: [] },
      result: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            seq: { type: 'number' },
            timestamp: { type: 'number' },
            preview: { type: 'string', description: 'Plain-text preview, collapsed to one line.' },
          },
          required: ['id', 'seq', 'timestamp', 'preview'],
        },
      },
    },
    /** 会话目录(TOC)的段落。 */
    segments: {
      title: 'Read the table of contents of the session',
      query: { type: 'object', properties: {}, required: [] },
      result: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            title: { type: 'string' },
            detail: { type: 'string' },
            startedAt: { type: 'number' },
            turnCount: { type: 'number' },
          },
          required: ['id', 'title'],
        },
      },
    },
    /**
     * 这条会话烧了多少 token。
     *
     * **不判会话在不在**(与上面几条不同,是刻意的):域那一侧对一条查无此会的
     * 会话答的是一份全零读数而不是「查无此会话」,而本单的硬约束是对外契约一个字
     * 不改。一份零读数在这里是诚实的 —— 没记过账与记过一笔零,对读数的消费者
     * (那条进度条)是同一件事。
     */
    tokenUsage: {
      title: 'Read the token usage of the session',
      query: { type: 'object', properties: {}, required: [] },
      result: {
        type: 'object',
        properties: {
          totalInputTokens: { type: 'number' },
          totalOutputTokens: { type: 'number' },
          totalTokens: { type: 'number' },
          maxTokens: { type: 'number' },
          lastInputTokens: { type: 'number' },
          contextSize: { type: 'number' },
        },
        required: [
          'totalInputTokens',
          'totalOutputTokens',
          'totalTokens',
          'maxTokens',
          'lastInputTokens',
          'contextSize',
        ],
      },
    },
  },
  ops: {
    /**
     * 前六条做法的 `effects` 都是**空数组**,这是想清楚的,不是省事:效果表管的是
     * 「这次调用会不会碰到人不知道的东西」(写盘、跑命令、连网、动系统能力)。
     * 改一条会话自己的名字或工作目录,主体本来就拥有这条会话 —— 为它弹一张权限卡
     * 是把审批变成噪音(与 `session_spawn` 从 ask 改回 silent 那次复盘同一条判据)。
     * **空效果不等于不留痕迹**:它照样落 `tool/audit`、照样发事件。
     *
     * 第七条 `removeMessage` 不在这句话里:它动的是账本本身,理由写在它自己那一格上。
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
       * **那笔留账在 K3-a' 还上了。**
       *
       * K2c-1 填的是空数组,理由是「效果表里没有一类装得下删,而这条做法唯一的
       * 调用方是壳上那个删除按钮,弹卡就是改行为」。K3-a 给效果表开了
       * `session_destructive` 那一格(policy `ask`),K3-a 又把资源工具放进了工具
       * 目录 —— 于是空数组当场变成一个洞:模型拿到 `session` 工具之后可以不问一声
       * 删掉一条消息。
       *
       * 这里写的是**上界**(自述说的从来是「这条做法最多会做到什么」)。真正发给
       * 授权者的那一条按**主体**分档,判据住在 provider 的 `plan` 里:用户删自己
       * 的消息不问(主体本来就拥有它),AI / 系统 / 插件删必须问。为什么分档在
       * provider 而不在权限核:见那只 `plan` 的注释。
       */
      effects: ['session_destructive'],
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
   * K1 **只声明不投影**:这一格说的是「这条会话的身份值得在每一回合喂进
   * `<context-update>` 尾块」,而真的把它接到提示词双通道上是 K4 的事(§4「提示词」
   * 那一行 = 变量系统,不另立)。现在写下来,是因为「哪些状态值得主动喂」是**自述**
   * 的一部分 —— 等到接的时候再补,那一刻就会有人想在提示词那一侧按 scheme 枚举。
   *
   * **值从 `get` 那条读法来,但键集是这一格自己的**(K4-a')。K1 写的是「喂的是这
   * 份摘要」,K4-a' 把那半句坐实成一张**独立的** schema(`SESSION_STATE_SCHEMA`):
   * 状态该长什么样是这一格自己的话,`get` 哪天多一格,不该因为一句别名就自动多喂
   * 给模型一格 —— 而 `messageCount` 正是那个反例,它每回合都动,一格就让整块变量板
   * 每回合重发。减了哪两格、为什么减,写在那张 schema 上。K4 接双通道时要的仍然是
   * 这一份,不是 `record`。
   */
  state: {
    current: {
      title: 'The session this turn is happening in',
      schema: SESSION_STATE_SCHEMA,
      volatility: 'turn',
      /**
       * K4-a:两格取址的话,两格都是这份自述自己说的。
       *
       *   · `read: 'get'` —— 状态叫 `current`,给出那份摘要的读法叫 `get`。同名
       *     约定是缺省(`StateSpec.read` 的注释),而这一条正是它不够用的第一个
       *     现场:改读法的名字去迁就投影方是本末倒置。
       *   · `scope: 'turn-origin'` —— 一条会话一个实例,而该喂的那一个就是**这一
       *     回合发起自的那一条**。地址由投影方按这句话拼(`<scheme>:<发起坐标>`),
       *     所以这份自述里一个地址字面量都没有。
       */
      read: 'get',
      scope: 'turn-origin',
    },
  },
}
