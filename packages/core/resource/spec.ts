/**
 * K0 —— 自述(`docs/design/atom-2026-09.md` §2「原子的定义」的 `ResourceSpec`)。
 *
 * **一种资源的自述:它有哪些读法、哪些做法、会发哪些事件、哪些状态值得喂给
 * 提示词。** 纯类型,零行为 —— 与 `../toolkit/spec.ts` 的 `ToolSpec` 同一个位置:
 * 「你是谁、你的契约长什么样、你最多可能做什么」,不含 registry / 权限 / 渲染的
 * 知识。那些是 K1 管线与 K2 各出口的事。
 *
 * 三个动词各占一格,对应 §0 那句话「原子 = 一个有地址的资源,加三个动词:读、
 * 做、看;『做』必须声明效果」:
 *   · `reads`  读:纯查询,无效果,可缓存 —— 所以 `ReadSpec` 里**没有** effects,
 *              那是类型层面的「读无效果」(§2 不变量 1)。
 *   · `ops`    做:带效果的变更。`effects` 是静态上界,`home` 说在哪跑。
 *   · `events` 看:这种资源会发哪些事实。事件是事实不是命令。
 *   · `state`  哪些读法值得主动喂进提示词(§4「提示词」那一行 = 变量系统的
 *              volatility 三档,不另立)。可选:大多数资源没有。
 *
 * ── 为什么这里一个 scheme 名都没有 ──────────────────────────────────────────
 * §2 不变量 3:内核不认识任何 scheme。这只文件描述的是「自述长什么样」,不是
 * 「有哪些自述」。§8 的陌生能力演练(接一个邮箱)之所以只要「能力自己的模块 +
 * 一行注册」,靠的就是这一条:内核里没有一处按 scheme 枚举,自然也没有一处要改。
 *
 * ── 复用而不是复制 ─────────────────────────────────────────────────────────
 * `JsonSchema` 与 `EffectClass` 都从 `../toolkit/` 拿。§3 那张表写得很清楚:
 * toolkit 的「做」的管线与效果模型**整个照用**,原子只是给它加一个 `ref`。在这里
 * 复制一份效果类枚举 = 立刻有两张会漂移的表,而权限只认效果 —— 漂移的代价是
 * 一个静默的授权洞。
 */

import type { JsonObject } from '../json.js'
import type { EffectClass } from '../toolkit/effects.js'
import type { JsonSchema } from '../toolkit/spec.js'

export type { JsonSchema }

/**
 * 一条做法在哪里执行(§5「位置:资源住在哪、谁跑」)。
 *
 * `core` = 引擎进程(会话、文件、音乐、外部应用);`shell` = 界面进程(开面板、
 * 聚焦、滚到某行、窗口)。路由规则一条:**调用方在哪不重要,资源的家在哪就去哪
 * 跑**;而不论往哪个方向,**授权永远在 core 里做**(壳不持有授权逻辑)。
 *
 * 它是闭合枚举而不是开放字符串:这不是「产品有哪些形态」那种内核不该知道的事,
 * 而是「这一步由谁执行」——只有两个进程角色,多出第三个就是路由要改的信号。
 */
export type OpHome = 'core' | 'shell'

/**
 * 一条读法。**没有 effects**,因为读无效果 —— 见文件头。
 */
export interface ReadSpec {
  /** 给人看的一句话(命令面板、目录页、MCP 出口的 description 都读它)。 */
  readonly title: string
  readonly query: JsonSchema
  readonly result: JsonSchema
}

/**
 * 一条做法在被问「此刻该不该露面」时拿到的上下文。
 *
 * 形状**刻意保持开放**,理由与 `../toolkit/spec.ts` 的 `Scene` 逐字相同:内核不该
 * 知道产品有哪些形态,它只负责把上下文原样递给 `when`。K1 把 `resolveScene` 从
 * 工具级抬到资源级(§3 那张表的 `resolveScene / Surface` 一行)时,这里会长出更多
 * 已归一化的判定结果格 —— 长的是「产品算好的答案」,不是原始会话字段。
 *
 * 注意它**不带 ref**:`when` 是场子级的闸(「这个 scheme 此刻在不在场」「这条会话
 * 有没有 active 目标」),不是实例级的闸。实例级的「这封邮件已经归档了所以不能再
 * 归档」要读状态,那是 I/O,回答不了一个同步的 boolean —— 它属于 plan 阶段的
 * 拒绝,由 `Outcome` 结构化地说出来(§2 `Do` → `Outcome`)。
 */
export interface OpContext {
  readonly sessionId?: string
  readonly metadata?: JsonObject
}

/**
 * 一条做法。
 */
export interface OpSpec {
  readonly title: string
  readonly params: JsonSchema
  /**
   * **静态上界**:这条做法**可能**产生哪些类的效果。语义与
   * `../toolkit/spec.ts` 的 `ToolSpec.effects` 一字不差 —— plan 阶段产出的具体效果
   * 不得超出它,越界是这条做法的 bug,由管线判失败(今天 toolkit 的
   * `runner.ts` / `assertWithinDeclaredEffects` 就是这么判的)。
   *
   * 空数组是合法的,含义是「这条做法不产生任何需要授权的效果」——它仍然是一条
   * 「做」(会落审计、会发事件),只是不打扰任何人。
   */
  readonly effects: readonly EffectClass[]
  readonly home: OpHome
  /** 此刻该不该露面。不给 = 一直露面。判据边界见 `OpContext` 的注释。 */
  readonly when?: (ctx: OpContext) => boolean
  /**
   * 把一次具体调用说成一句人话(权限卡标题、审计行、命令面板的二级说明)。
   * 参数是 `unknown` 而不是泛型:内核不解释 `params`,它只知道那是一坨 JSON,
   * 解释权归写这条做法的人 —— 与 `JsonSchema` 的解释权归 `Validator` 端口同理。
   */
  readonly describe?: (params: unknown) => string
  /** 进不进命令面板 / 快捷键表(§4「界面动作」那一行)。缺省不进。 */
  readonly keymap?: boolean
  /**
   * 这条做法作用在这种资源的哪一类实体上,给出口按实体聚合用(右键一条消息列
   * 消息的做法,而不是把整个 scheme 的做法都列出来)。**内核不解释它**,只透传:
   * 一种资源里有哪几类实体,是那种资源自己的事。
   */
  readonly entity?: string
}

/**
 * 一条事实打断人的价值(`docs/design/pet-system-2026-09.md` §2.2)。
 *
 *   · `high`   —— 值得当场说出来;
 *   · `normal` —— 只在旁边安静的时候才值得说;
 *   · `low`    —— 记住就够了,最多嘀咕一句。
 */
export type MomentWeight = 'high' | 'normal' | 'low'

/**
 * 「这条事实值得在场的旁观者知道」的声明。
 *
 * **内核不解释它,只透传**:登记时查形状(`contract.ts`)、`describe` 时带出去,
 * 谁读、读了之后怎么做都不是这一层的事。它写在事件自述上而不是某张订阅名单里,
 * 理由与 `ResourceExposure` 同一条:名单是「按能力枚举」的形状,自述才是读表。
 * 发这条事实的资源因此**不知道**谁在看。
 */
export interface EventMoment {
  readonly weight: MomentWeight
  /** 给模型看的一句话:这条事实在人话里是什么意思。 */
  readonly gist: string
}

/** 一种事件。事件是事实,不是命令(§2 `Watch`)。 */
export interface EventSpec {
  readonly title: string
  readonly payload: JsonSchema
  /** 这条事实值得旁观者知道。缺省 = 旁观者看不见它。内核不解释,只透传。 */
  readonly moment?: EventMoment
}

/**
 * 状态的易变度。三档与变量系统的 volatility 逐字同名同义(§3 那张表):
 *   · `stable` 跨会话逐字相同 → 进 system 前缀;
 *   · `turn`   随回合变 → 进 `<context-update>` 尾块,按块去重;
 *   · `live`   一直在变 → 不主动喂,只在工具结果里出现。
 */
export type StateVolatility = 'stable' | 'turn' | 'live'

/**
 * 一格状态的地址从哪来(K4-a)。
 *
 * `state` 说的是「这种资源的哪一格值得主动喂给提示词」,而喂之前投影方得知道
 * **喂哪一个实例的**。两种答案,不是两个开关:
 *
 *   · `singleton`   —— 这台机器上只有一个(播放器、剪贴板、一台电台)。地址由这种
 *                      资源自己的坐标系说了算,投影方拿不出来 —— 见下面那段。
 *   · `turn-origin` —— 一个实例对应一条会话,而**这一回合是从哪条会话里发起的**
 *                      (`ResourceCallOptions.sessionId`,内核自己管它叫「发起坐标」,
 *                      见 `kernel.ts` 的 `NO_ORIGIN_SESSION`)就是该喂的那一个。
 *                      地址 = `<scheme>:<那条发起坐标>`。
 *
 * 缺省是 `singleton`,理由与 `ResourceSpec.state` 本身可选同一条:绝大多数资源
 * 只有一个,让它们为一件不成立的事写一格是噪音。
 *
 * ## 为什么名字里不出现任何一种资源
 *
 * 第一版这一格叫「按会话分」,把那三个字直译成英文写进字面量,当场被
 * `__tests__/stranger.test.ts` 抓红:那个词的后半截**逐字就是今天第一个真命名空间
 * 的名字**,而内核不许提任何能力的名字(§2 不变量 3)。这不是误伤 —— 一个叫
 * 「按 xxx 分」的枚举值,读起来就是内核认识 xxx。`turn-origin` 说的是同一件事,
 * 用的是内核**自己**的词(发起坐标,见 `kernel.ts` 的 `NO_ORIGIN_SESSION`)。
 *
 * 同理这一格不叫「要不要 ref」:那是按**投影方**的坐标系命名的
 * (「要不要塞一个会话 id 进去」),于是每加一种取址方式就要在内核的类型里多一个
 * 枚举值。这一格反过来 —— 它说的是**这种资源自己**的实例学(一个,还是一条会话
 * 一个),取址是读表的人按这句话推出来的。
 *
 * ## `singleton` + `turn` 今天喂不出去,而这是自觉的
 *
 * `ResourceKernel.read` 要一个**完整地址**(`parseRef` 拒绝空路径),而 `singleton`
 * 这句话本身不含路径 —— 一种单例资源的地址是它自己取的那个名字,那是它的坐标系,
 * 不是一条能被内核推导的规则。所以今天的投影只喂 `turn-origin` 的那一档;第一个
 * `singleton` + `turn` 的状态出现时,该补的是「这种资源的单例地址是什么」这一格,
 * 而不是让投影方去猜。今天零个这样的状态,所以这是留账不是缺口 —— K4-a 的装配级
 * 用例把这句话钉住了。
 */
export type StateScope = 'singleton' | 'turn-origin'

/** 哪些读法值得主动喂给提示词,以及多勤地喂。 */
export interface StateSpec {
  readonly title: string
  readonly schema: JsonSchema
  readonly volatility: StateVolatility
  /**
   * 用**哪一条读法**把这格状态的值取回来。缺席 = 与这格状态同名的那条读法。
   *
   * 这一格在 K4-a 之前不存在,于是「`state` 里写着 `current`,值从哪来」只有一个
   * 答案:同名的读法。会话那份自述当场证明那不够 —— 它的状态叫 `current`,而给出
   * 那份摘要的读法叫 `get`。同名约定继续当缺省(绝大多数资源会让两者同名),但
   * 「不同名」必须说得出口,否则那种资源就只能改自己读法的名字去迁就投影方。
   *
   * 契约校验会查它**指向一条真实存在的读法**:一个指空的 `read` 在登记时是可查的
   * 拼写错误,到了投影期就只剩一格安静消失的状态。
   */
  readonly read?: string
  /** 这格状态属于哪一个实例(见 `StateScope`)。缺省 `singleton`。 */
  readonly scope?: StateScope
}

/**
 * 这份自述往哪些出口投影(K5-a)。
 *
 * §4「所有出口都是投影」的默认是**每个出口都投**:一份自述交上来,AI 工具、RPC、
 * 命令面板、CLI、MCP 出口各自读表生成自己那一份。这一格是那句默认的**例外声明**,
 * 而它存在的理由只有一条:**一件事不许有两只工具**。
 *
 * 具体到今天:外部驱动把一个已经在别处被投影成工具的东西(一台外部 server 的工具
 * 表)再投影成一个命名空间,于是模型面上会同时出现「那只旧工具」与「这个新命名
 * 空间的工具」——同一件事两条路,权限卡上两个名字,而模型会两条都试。声明
 * `aiTool: false` 的意思是:这一 scheme 的 RPC / CLI / 插件 / 出口那几条路照常,
 * **只有模型面那一份投影不生成**。
 *
 * 它不是「隐藏」:元工具 `resources` 的 `list` 照列它(它确实是一种资源,而且
 * 模型经元工具点名之后仍然够得着它),RPC 的 `describe` 照答,注册表照登记。
 *
 * ── 为什么是一格自述,而不是出口那一侧的一张名单 ────────────────────────────
 * 名单是「按能力枚举」的形状:每加一种这样的资源,`catalog-sync.ts` 里就要多一行
 * 它的名字,而内核与出口都不许认识任何 scheme(§2 不变量 3)。写在自述里,出口
 * 读的仍然是表。
 *
 * 缺席 = 全都投(`aiTool` 缺席同理)。绝大多数资源不需要这一格,给它们强行写一个
 * `exposure: {}` 是噪音 —— 与 `state` 可选同一条理由。
 */
export interface ResourceExposure {
  /**
   * 进不进模型面的工具目录。缺省 `true`。
   *
   * `false` 只关掉「一个 scheme 一只 `ResourceTool`」那一份投影;元工具的清单、
   * RPC、CLI、内核的 `do` / `read` 全都不受影响。
   */
  readonly aiTool?: boolean
}

/**
 * 一种资源的自述。这就是 §5 说的「一个命名空间的资源表」——
 * 上一篇 `app-intents-2026-09.md` 的整张能力面,在本文里退化成它加几格登记。
 *
 * 三张表都是**必填**(空表合法):一种资源可以只有读法没有做法,也可以只发事件
 * 不接受操作,但「有没有这一格」不该靠 `undefined` 来表达 —— 缺省与空的区别在
 * 读表的人那里永远是一次多余的分支。`state` 例外,它是可选的:绝大多数资源不进
 * 提示词,给它们强行写一个 `state: {}` 是噪音。
 */
export interface ResourceSpec {
  readonly scheme: string
  /** 给人看的名字(设置里的命名空间许可、命令面板的分组、MCP 出口的 server 名)。 */
  readonly title: string
  readonly reads: Readonly<Record<string, ReadSpec>>
  readonly ops: Readonly<Record<string, OpSpec>>
  readonly events: Readonly<Record<string, EventSpec>>
  readonly state?: Readonly<Record<string, StateSpec>>
  /** 这份自述往哪些出口投影。缺席 = 全都投,见 {@link ResourceExposure}。 */
  readonly exposure?: ResourceExposure
}
