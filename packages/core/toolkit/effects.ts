/**
 * §3 内核 —— EffectClass 目录 + 默认策略表(§10.2-② 列为 R0 的第一件事)。
 *
 * 权限只认效果、不认工具。既然如此,「有哪些效果类」和「每一类默认怎么处理」
 * 就必须是**一张表**,而不是散在判定函数里的一串 if —— `read` 静默、写/bash/mcp
 * 询问、`capability_change` 永不可授。
 *
 * **合表(2026-09-10 用户拍板):这张表是唯一真相。** 在此之前
 * `core/permission/permission-policy.ts` 还留着一份自己的 `SILENT_EFFECT_KINDS`
 * 名单、`permission-grants.ts` 还留着一份自己的 `NEVER_GRANTABLE_TYPES` 名单,三处
 * 管同一个问题而**行为的产地是那两处**:这张表里写 `silent` 的类照样弹卡。合表把
 * 那两张名单删掉,两处都改读这里的 `policy`。于是「加一个效果类」= 在这张表里加
 * 一行,不需要再去别处补名单;而「某一类要不要问」有且只有一个答案。
 *
 * 同目录的测试钉住「每个 kind 都有策略行」以及「与 core 的 barrier 判定不矛盾」;
 * `core/permission/__tests__/silent-effects.test.ts` 钉住「只有一张表」本身 ——
 * 它遍历 `EFFECT_CLASSES` 比对 `decidePermission` 的实际静默集合与这一列,任何一次
 * 「在判定核里偷偷加回一个名单」都会当场红。
 *
 * 纪律(§9 风险 2 的处理):kind 名沿用 core 现有的 9 个,**只许新增不许改名**;
 * 新增一个 kind = 在这张表里加一行(policy + 权限卡文案),没有行就等于这个效果
 * 类不存在。未知 kind 一律按 `ask` 兜底 —— 内核宁可多问一次,也不静默放行。
 */

import type { JsonObject } from '../json.js'

/**
 * 效果类。前 9 个与 `core/tools/tool-effect.ts` 的 `ToolEffectKind` 逐字对应
 * (这是唯一一处已经"按效果"思考的旧代码,不重命名它);其余是后来各期在这张表里
 * 加的行(§10.2-② 四条、R3a 的 `plugin_exec`、R4b 的 `external-agent`、原子 K2a' 的
 * `ui_change`),命名沿用下划线风格 —— `external-agent` 那一条的连字符有它自己的
 * 理由,写在它那一行上。
 */
export type EffectClass =
  | 'read'
  | 'file_edit'
  | 'file_write'
  | 'file_destructive_edit'
  | 'bash'
  | 'mcp'
  | 'external_directory'
  | 'sensitive_file_read'
  | 'capability_change'
  | 'net_fetch'
  | 'user_ask'
  | 'session_message'
  | 'session_spawn'
  | 'session_destructive'
  | 'plugin_exec'
  | 'external-agent'
  | 'ui_change'
  | 'browser_navigate'

/**
 * 默认处置:
 * - `silent`         无需询问(权限核里就是"不进 promptEffects"的那一类)
 * - `ask`            要问,答案可被 grant 记住
 * - `never-grantable` 每次都问,答案永不可记忆(它改变的是系统自己能够到哪里)
 */
export type EffectPolicy = 'silent' | 'ask' | 'never-grantable'

export interface EffectPolicyRow {
  readonly kind: EffectClass
  readonly policy: EffectPolicy
  /** 权限卡的默认标题。工具在 `Intent.preview.title` 给了更具体的就用工具的。 */
  readonly prompt: string
  /** 并发屏障。与 `core/tools/tool-effect.ts` 的 `isBarrierEffect` 同口径。 */
  readonly barrier: boolean
}

const ROWS: readonly EffectPolicyRow[] = [
  // 读在根内是静默的。越界读与敏感读不是"读"的加强版参数,而是**另外两个 kind**
  // —— 由 plan 阶段决定报哪一个,权限层因此不需要认识路径。
  { kind: 'read', policy: 'silent', prompt: 'Read files', barrier: false },
  { kind: 'file_edit', policy: 'ask', prompt: 'Edit file', barrier: true },
  { kind: 'file_write', policy: 'ask', prompt: 'Write file', barrier: true },
  { kind: 'file_destructive_edit', policy: 'ask', prompt: 'Overwrite file', barrier: true },
  { kind: 'bash', policy: 'ask', prompt: 'Run bash command', barrier: true },
  { kind: 'mcp', policy: 'ask', prompt: 'Run MCP tool', barrier: true },
  { kind: 'external_directory', policy: 'ask', prompt: 'Access directory outside project', barrier: false },
  { kind: 'sensitive_file_read', policy: 'ask', prompt: 'Read sensitive file', barrier: false },
  // 它改的是"助手能够到哪里",提议可以由助手发起,但答案永远不进 grant 表。
  { kind: 'capability_change', policy: 'never-grantable', prompt: 'Repoint capability', barrier: true },
  /**
   * ## 合表(2026-09-10 拍板)——「要不要问」从此**只有这一列**
   *
   * 在此之前权限核那一侧还有第二张表(`core/permission/permission-policy.ts` 的
   * `SILENT_EFFECT_KINDS = {read, ui_change}`),两张表管同一个问题,而**行为的产地
   * 是那一张**:这四行写着 `silent`,真跑起来照样弹卡 —— 表说的话不作数。合表把那
   * 张名单删掉、改读这里的 `policy`,于是合表本身先要回答「这四类到底该不该问」:
   *
   *  - `net_fetch` —— 出网取一份**只读**的东西(web_search 发几条 query、web_open
   *    抓一页)。它不动这台机器上的任何东西,而每查一次资料弹一张卡就是把审批变成
   *    噪音(08-18「弹卡是噪音」判例)。**silent** —— 这是合表带来的真实行为变化:
   *    web_search / web_open 从此不再弹卡。
   *  - `user_ask` —— 这只工具要问用户一句话。它**本身就是一次询问**,为「我要问你
   *    一个问题」先弹一张「准不准我问你」的卡,是同一件事问两遍,而且第二遍还挡在
   *    第一遍前面。**silent** —— 同样是合表带来的行为变化。
   *
   * `silent` 不等于不留痕:两类照样落 `tool/audit`,照样发事件。
   */
  { kind: 'net_fetch', policy: 'silent', prompt: 'Fetch a URL', barrier: false },
  /**
   * 让**内嵌浏览器**去一个地址(B1-a,`apps/desktop-react/docs/terminal-browser-2026-09.md`
   * §9-2 / 拍点 ③)。
   *
   * ## 为什么它不是 `net_fetch`
   *
   * 上面那一行管的是**匿名 fetch**:`web_search` 发几条 query、`web_open` 抓一页 ——
   * 没有 cookie、没有身份,抓回来的是任何人都看得见的那一份,所以静默。
   *
   * 内嵌浏览器不是这样。它跑在 `persist:browser-<profile>` 上,**登着用户的账号**;
   * 让它 `navigate` 到一个地址 = 带着那份 cookie 以用户的身份发一个请求。一个 GET
   * 就能退出登录、确认一笔订单、接受一次邀请。这与匿名取材不是一类事,不该共用
   * 一行策略 —— 共用就等于把「以你的身份点一下」降级成「查一次资料」。
   *
   * `ask` 而不是 `never-grantable`:它是可记忆的。用户经许可卡答一次「始终允许
   * browser:*」就一次放行(`alwaysScopeOf` 认得出这一族的地址,合表 863332c7 /
   * a50d4f99 的那条路白拿),而不是每开一页问一遍。
   *
   * `barrier: false`:两次导航之间没有共享坐标要保护 —— 两格 tab 各走各的,
   * 而同一格 tab 的两次导航本来就是后一次盖前一次(那是浏览器的语义,不是竞态)。
   *
   * **读不在这一行里**:`page` / `screenshot` 两条读法零效果(读无效果是结构性的,
   * `ReadSpec` 里根本没有 effects 这一格);`activate` / `close` 是 `ui_change`
   * ——它们动的是这个人自己那扇窗。
   */
  { kind: 'browser_navigate', policy: 'ask', prompt: 'Navigate the built-in browser', barrier: false },
  { kind: 'user_ask', policy: 'silent', prompt: 'Ask the user a question', barrier: false },
  /**
   * 往**另一条会话**里投一条消息。合表后 `ask` —— **是表跟上了行为,不是行为变了**
   * (判定核这一侧从 R0 之前就在问它,这一行的 `silent` 只是一句不作数的话)。
   *
   * 理由与 `session_destructive` 同源:它动的是**别处**。收件人是另一条会话里的那个
   * 人 / 那个 agent,投出去就收不回来,而这一行是唯一能在投出去之前把它拦下来的
   * 地方。`barrier: false` 照旧 —— 两条投递之间没有共享坐标可保护。
   */
  { kind: 'session_message', policy: 'ask', prompt: 'Post a message to a session', barrier: false },
  /**
   * 开一条子会话。合表后 `ask` —— 同样是**表跟上行为**,今天派工就在弹卡。
   *
   * R3a 复盘曾把这一行改成 `silent`,理由是「派工的本义就是派出去继续干,为它弹卡
   * 等于让用户为『要不要开始』点一次同意,再为那条会话里的每一次真实副作用点第二
   * 次」。那条理由只在**两张表已经合了**的世界里才有意义 —— 在真实的树里它一天都
   * 没有生效过(判定核照旧问),所以它不是「今天的行为」,而是一个从未兑现的意图。
   * 2026-09-10 合表时用户按「往别的会话发消息、开子会话是真有后果的」拍回 `ask`:
   * 派工会让另一个主体开始花钱和动手,这一下值一次同意;至于那条子会话里后续的每
   * 一次写盘 / 跑命令,由它自己的权限卡照常兜住(它继承调用方的权限模式),两道闸
   * 不是重复而是各管一段。
   *
   * `barrier: true` 与合表无关,照旧:两次并发登记会把并发闸
   * (`TASK_MAX_CONCURRENT_PER_SESSION`)算错。
   */
  { kind: 'session_spawn', policy: 'ask', prompt: 'Start a sub-session', barrier: true },
  /**
   * K3-a —— **拿掉会话账本里已经存在的东西**:删一条消息、删一条会话、清空一段
   * 抄本(`docs/design/atom-2026-09.md` §9 K3;`app-intents-2026-09.md` §7 盲点 3
   * 「破坏性动作(删邮件、发消息、清空歌单)走 `ask`」)。
   *
   * ## 为什么它不是 `session_message` 的一档
   *
   * `session_message` 说的是「往会话里写一条消息」,而写与删在授权上不是同一件事:
   * 前者今天全仓都不打扰人(插件信使、`/files` 补一条系统消息),后者动的是**账本
   * 本身** —— `events.jsonl` 是这个产品唯一的事实来源(F 线三定律),删掉的东西
   * 没有第二个地方还留着。硬套过去会让「补一条」与「删一条」在权限卡、grant 表和
   * 审计账里长成同一句话,而账本是要被人读的(`plugin_exec` 不复用 `mcp` 的同一
   * 条理由)。
   *
   * ## `ask` 而不是 `never-grantable`
   *
   * `never-grantable` 留给「改变系统自己能够到哪里」那一档(`capability_change`)。
   * 删一条消息是这个人自己的数据、在这个人自己的会话里,他说一次「这类总是可以」
   * 应该算数。真正不可逆到该进 `never-grantable` 的(清空账户那种)今天没有产地。
   *
   * `barrier: true`:它与同一条会话上并发的读 / 写在账本上抢同一批坐标。
   */
  { kind: 'session_destructive', policy: 'ask', prompt: 'Remove session content', barrier: true },
  // R3a:跑一段**插件**写的代码。旧路把这句话写成 `permissionGuard:
  // 'permission-gated'`(`app/plugins/api.ts` 写死,插件填什么都会被覆盖:
  // "插件不能给自己发免检通行证")。新树里 guard 是派生值,所以那句话必须由
  // 一条效果说出来。不复用 `mcp`:那会在权限账本与卡片文案里把一个插件写成
  // 一台 MCP 服务器,而账本是要被人读的。
  { kind: 'plugin_exec', policy: 'ask', prompt: 'Run plugin tool', barrier: true },
  /**
   * R4b —— 一台**外部 agent**(Claude Code SDK / ACP)要动手做一件我们认不出的事。
   *
   * 它在 R4b 之前是一条**不在任何表里**的手搓 kind,由
   * `app/external-agents/index.ts` 与 `app/acp/permission-bridge.ts` 各自直接喂给
   * 权限核 —— 一个不在任何表里的效果类,策略靠"权限核不认识它所以走 ask"这条
   * 巧合成立。§15.5-7 记的就是这一条:要让那两处改调 `Authorizer.decide`,它得先
   * 是一行。名字**逐字沿用**那条旧字符串(连字符,与本表其余下划线风格不同):
   * 它同时是权限卡的 `type`,而渲染器与它的测试都按这个字面量分支 —— 改成
   * `external_agent` 会是一次悄悄的契约变更。
   *
   * `ask`(可被 grant 记住,pattern 是工具名),`barrier` 为真:外部这一步与本地
   * 工具一样可能写盘/跑命令,认不出内容时按最强的那一档排队。
   */
  { kind: 'external-agent', policy: 'ask', prompt: 'Run an external agent tool', barrier: true },
  /**
   * K2b-1 留账的拍点(`docs/design/atom-2026-09.md` §6):壳里开一格、激活一格、
   * 移动一格、把一格撕成浮窗 —— 这类做法的效果类。
   *
   * **它不是「没有副作用」,是「副作用只在界面上,而且主体本来就拥有它」。** 那扇
   * 窗是这个人的窗;为「把面板挪到右边」弹一张权限卡,与 08-18「弹卡是噪音」那条
   * 判例是同一件事。所以 `silent`,而且 `barrier: false` —— 两条界面动作彼此无关,
   * 排队没有任何东西可保护(资源上的做法要串行是 `ResourceTool` 自己说的事)。
   * silent 不等于不留痕:它照样落 `tool/audit`,照样发事件。
   *
   * **`close` 这类可能丢掉未保存内容的动作不另立一类。** 立 `ui_destructive` 要的
   * 事实是「这一格里有没有没保存的东西」,而那个事实**只有壳知道** —— core 的效果
   * 表里再多一行也说不出它,只能变成一个恒真或恒假的标签。那道闸留在壳侧的
   * `beforeClose` 确认上,那里才有那个事实。
   */
  { kind: 'ui_change', policy: 'silent', prompt: 'Change the interface', barrier: false },
]

export const EFFECT_POLICY: Readonly<Record<EffectClass, EffectPolicyRow>> = Object.freeze(
  Object.fromEntries(ROWS.map(row => [row.kind, Object.freeze(row)])) as Record<EffectClass, EffectPolicyRow>,
)

export const EFFECT_CLASSES: readonly EffectClass[] = Object.freeze(ROWS.map(row => row.kind))

/** 一条具体效果(plan 产出的,带资源)。上界是 `ToolSpec.effects` 里的类。 */
export interface Effect {
  readonly kind: EffectClass
  readonly resources: readonly string[]
  /** 覆盖策略表的屏障判定。工具知道得更细时(只读某个文件)可以放松。 */
  readonly barrier?: boolean
  /** 落在项目根之外 —— `auto-accept-edits` 不吃这一位(见 permission-policy 的注释)。 */
  readonly external?: boolean
  readonly sensitive?: boolean
  readonly metadata?: JsonObject
}

export function isKnownEffectClass(kind: string): kind is EffectClass {
  return Object.prototype.hasOwnProperty.call(EFFECT_POLICY, kind)
}

/**
 * 不认识的 kind 不抛错、也不放行:合成一条 `ask` 行。内核在这里选择"多问一次"
 * 而不是"崩掉这次调用",因为一个拼错的效果名不该让工具不可用,但更不该静默。
 */
export function effectPolicyFor(kind: string): EffectPolicyRow {
  if (isKnownEffectClass(kind)) return EFFECT_POLICY[kind]
  return { kind: kind as EffectClass, policy: 'ask', prompt: `Use ${kind}`, barrier: true }
}

export function policyOf(effect: Effect): EffectPolicy {
  return effectPolicyFor(effect.kind).policy
}

export function isBarrierEffect(effect: Effect): boolean {
  return effect.barrier ?? effectPolicyFor(effect.kind).barrier
}

/** 这一组效果里有没有需要人回答的。`silent` 全集 = 这次调用不必打扰任何人。 */
export function requiresAuthorization(effects: readonly Effect[]): boolean {
  return effects.some(item => policyOf(item) !== 'silent')
}

export function makeEffect(
  kind: EffectClass,
  resources: readonly string[] = [],
  extra: Omit<Effect, 'kind' | 'resources'> = {},
): Effect {
  return { kind, resources, ...extra }
}
