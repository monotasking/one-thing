/**
 * K1 —— 管线在资源这一层会说的几句「不」。
 *
 * 与 `contract.ts` 的 `ResourceSpecProblem` 分工清楚:那一族说的是「**这份自述**
 * 写错了」(登记期,人写的),这一族说的是「**这次调用**过不去」(运行期,来自
 * 模型的工具参数、deeplink、脚本)。两族都必须是具名的、带定位字段的 —— 判定分支
 * 读类名与字段,而不是 match 一句会被改的措辞(`core/tools/abort.ts` 头注释那条
 * 判例:靠消息文本分类,迟早把一次失败洗成一次取消)。
 *
 * ── 它们最后变成哪一种 `Outcome` ───────────────────────────────────────────
 * 全部是 `failed` —— 因为它们是从 `Tool.plan` 抛出去的,而 `ToolRunner` 对 plan 期
 * 的抛出只有一条路(`Outcome.fromError`)。**内核里没有第二个 `invalid` 的产地**:
 * `runner.ts` 里 `Outcome.invalid` 只在 `validator.parse` 不过时出现,而 `Validator`
 * 是宿主注入的端口,`plan` 够不着它。
 *
 * 这一点是自觉的取舍,不是遗漏:把「op 拼错了」判成 `failed` 的代价是模型看到的
 * 是 `Tool execution failed: …` 而不是一句纯粹的参数错;换取的是**不新造一条路**
 * —— 想让它成为 `invalid`,正确的做法是给这份生成 schema 配一个认得它的
 * `Validator`(K2 装配 RPC 通用处理器时顺带),而不是在内核里给 plan 开一个能返回
 * `Outcome` 的后门。留账写在 `docs/design/atom-2026-09.md` 的 K1 行。
 */

/** 这个 scheme 上没有这条做法。op 名直接来自外面(模型参数 / deeplink)。 */
export class ResourceOpUnknownError extends Error {
  readonly scheme: string
  readonly op: string

  constructor(scheme: string, op: string) {
    super(`Resource ${scheme} has no op ${JSON.stringify(op)}`)
    this.name = 'ResourceOpUnknownError'
    this.scheme = scheme
    this.op = op
  }
}

/**
 * 这次调用既没说读哪一条,也没说做哪一条。
 *
 * 生成的 schema 是一个 `oneOf` 可辨识联合,每一支都把判别字段写进 `required` ——
 * 所以一个认得这份 schema 的 `Validator` 本来会把它判成 `invalid`。内核这一层
 * 仍然自己判一次(见文件头:`plan` 够不着 Validator),而且**给它一个自己的名字**:
 * 「你一条都没点名」和「你点的那条不存在」是两句不同的人话,合成一句会让模型在
 * 第一种情形下去猜自己是不是把 op 拼错了。
 */
export class ResourceCallShapeError extends Error {
  readonly scheme: string

  constructor(scheme: string) {
    super(`Resource ${scheme}: the call names neither a read nor an op`)
    this.name = 'ResourceCallShapeError'
    this.scheme = scheme
  }
}

/** 做法在,但 `OpSpec.when` 说此刻不该露面(场子级的闸,不是实例级的)。 */
export class ResourceOpUnavailableError extends Error {
  readonly scheme: string
  readonly op: string

  constructor(scheme: string, op: string) {
    super(`Resource ${scheme}: op ${JSON.stringify(op)} is not available in this scene`)
    this.name = 'ResourceOpUnavailableError'
    this.scheme = scheme
    this.op = op
  }
}

/**
 * 做法的家在壳里,而这台宿主没有壳(§5「没有壳就 `Outcome` 里说『这个宿主没有
 * 界面』」)。**结构化降级,不是静默** —— 一个静悄悄什么都不做的 apply,会让 AI
 * 以为窗口已经滚到了那一行。
 */
export class ResourceHomeUnavailableError extends Error {
  readonly scheme: string
  readonly op: string
  readonly home: string

  constructor(scheme: string, op: string, home: string) {
    super(`Resource ${scheme}: op ${JSON.stringify(op)} runs in the ${home}, and this host has none`)
    this.name = 'ResourceHomeUnavailableError'
    this.scheme = scheme
    this.op = op
    this.home = home
  }
}

/**
 * 一条做法报出了自己**没声明过**的效果。
 *
 * 与 `toolkit/runner.ts` 的 `EffectViolationError` 是同一件事的两个粒度:那一条查
 * 的是 scheme 级的并集(这只工具**可能**产生哪些效果),这一条查的是**这条做法**
 * 自己的上界。少了这一条,一条声明 `effects: []` 的重命名只要与一条声明了 `bash`
 * 的做法同住一个 scheme,就能安静地报出 `bash` 并通过 scheme 级检查。
 */
export class ResourceEffectViolationError extends Error {
  readonly scheme: string
  readonly op: string
  readonly kinds: readonly string[]

  constructor(scheme: string, op: string, kinds: readonly string[]) {
    super(`Resource ${scheme}: op ${JSON.stringify(op)} planned undeclared effects: ${kinds.join(', ')}`)
    this.name = 'ResourceEffectViolationError'
    this.scheme = scheme
    this.op = op
    this.kinds = kinds
  }
}

/**
 * 传进来的地址有问题。两种:`syntax` = 不是一个合法地址;`scheme` = 是合法地址,
 * 但它属于**另一种资源**(拿一个 `a:` 开头的地址去调 `b` 那只工具)。
 *
 * 后一种是必须挡的:一只工具只认识自己那一个 scheme 的坐标系,把别人的地址原样
 * 递给它,得到的是一次按错误坐标系执行的做法 —— 而它会安静地成功。
 */
export class ResourceRefError extends Error {
  readonly scheme: string
  readonly value: string
  readonly reason: 'syntax' | 'scheme'

  constructor(scheme: string, value: string, reason: 'syntax' | 'scheme') {
    super(
      reason === 'syntax'
        ? `Resource ${scheme}: ${JSON.stringify(value)} is not a resource address`
        : `Resource ${scheme}: address ${JSON.stringify(value)} belongs to another resource`,
    )
    this.name = 'ResourceRefError'
    this.scheme = scheme
    this.value = value
    this.reason = reason
  }
}

/** 没人登记过这个 scheme。给 `ResourceKernel` 的非 AI 调用方用。 */
export class ResourceSchemeUnknownError extends Error {
  readonly scheme: string

  constructor(scheme: string) {
    super(`No resource is registered for scheme: ${scheme}`)
    this.name = 'ResourceSchemeUnknownError'
    this.scheme = scheme
  }
}

/** `watch` 的前缀不合 `isRefPrefix` 的两种形状。 */
export class ResourceWatchPrefixError extends Error {
  readonly prefix: string

  constructor(prefix: string) {
    super(`Not a resource address prefix: ${JSON.stringify(prefix)} (expected "<scheme>:" or "<scheme>:<path>/")`)
    this.name = 'ResourceWatchPrefixError'
    this.prefix = prefix
  }
}
