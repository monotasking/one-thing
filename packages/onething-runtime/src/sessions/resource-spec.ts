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
     * 两条做法的 `effects` 都是**空数组**,这是想清楚的,不是省事:效果表管的是
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
