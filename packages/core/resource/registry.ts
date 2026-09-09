/**
 * K0 —— 注册表(`docs/design/atom-2026-09.md` §2 不变量 3、§9 分期 K0)。
 *
 * **谁提供一种资源,谁交一份 `ResourceSpec` 来登记;内核只做路由与管线。** 这只
 * 文件是「登记」那一半:一张 scheme → 自述的表,加上按地址查回去的几条路。
 * 管线(校验 → 拦截 → plan → 授权 → apply → 审计 → 发事件)是 K1 的事,不在这里;
 * 这里连「执行」两个字都不该出现 —— `ResourceSpec` 是纯数据,实现由上层持有。
 *
 * ── 为什么是类,不是模块级单例 ─────────────────────────────────────────────
 * 组合根法条(`docs/design/backend-composition-root-2026-09.md`,`assembly:gate` 在
 * 执法):装配期的状态住在实例上、由 `own()` 收尾,不住在模块槽里。core 更严 ——
 * 它一个进程槽都不该有。所以这只文件里没有 `let`、没有 `export const registry`:
 * 谁要一张表谁自己 `new` 一个,`OnethingBackend` 将来把它当字段持有。
 * 好处在测试里立刻兑现:`stranger.test.ts` 起一张全新的表,不必先把上一个用例
 * 留下的登记清干净。
 *
 * ── 冻结为什么是浅的 ───────────────────────────────────────────────────────
 * `register` 就地 `Object.freeze` 这份自述,于是 `get()` / `list()` 交出去的东西
 * 改不动 —— 挡的是「拿到 spec 之后往上面挂一格」「把 `ops` 整张换掉」这类会让
 * 注册表说谎的改动(注册表是权限与出口生成的共同事实来源,它一旦能被事后改写,
 * 「登记过什么」就不再可信)。
 *
 * 浅冻而不是深冻,两条理由:
 *   ① 深冻要递归走 JSON Schema 整棵树。schema 可能很大、可能在多条读法之间共享
 *      同一个对象,一次登记就把整棵树冻上是把代价押在了几乎不会发生的事故上;
 *   ② 内核对 schema 的全部认识是「一坨 JSON 对象」(`../toolkit/spec.ts`),它本来
 *      就只被当值读。真要防的是**结构**被改,而结构就在第一层。
 * 代价说清楚:`spec.ops.send.title = 'x'` 仍然改得动。这是自觉的取舍,不是遗漏。
 *
 * 另外 `register` 冻的是**实参本身**而不是一份拷贝:自述是值不是可变对象,拷贝
 * 会让 `get()` 与调用方手里的不是同一个东西(身份一分为二),而浅拷贝连嵌套表都
 * 拦不住 —— 花了钱没买到东西。
 */

import { assertResourceSpec } from './contract.js'
import { parseRef } from './ref.js'
import type { ResourceRef } from './ref.js'
import type { OpSpec, ReadSpec, ResourceSpec } from './spec.js'

/** 一个 scheme 只能有一个提供者。第二个来登记是装配错误,不是可降级的情况。 */
export class ResourceSchemeTakenError extends Error {
  readonly scheme: string

  constructor(scheme: string) {
    super(`Resource scheme already registered: ${scheme}`)
    this.name = 'ResourceSchemeTakenError'
    this.scheme = scheme
  }
}

/** `resolve` 的答案:这个地址属于哪种资源,以及拆开的地址。 */
export interface ResolvedRef {
  readonly spec: ResourceSpec
  readonly ref: ResourceRef
}

/**
 * 只查自己身上有的键。
 *
 * 不写这一步的话 `opOf(ref, 'toString')` 会从 `Object.prototype` 上摸到一个函数并
 * 当成一条做法交出去 —— 而 op 名会直接来自模型的工具参数与 deeplink,即外面。
 */
function own<T>(table: Readonly<Record<string, T>>, name: string): T | null {
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : null
}

export class ResourceRegistry {
  private readonly specs = new Map<string, ResourceSpec>()
  private readonly listeners = new Set<() => void>()

  /**
   * 登记一种资源。返回**幂等**的注销函数 —— 与 core 其余「谁开的谁关」的地方
   * (`registerPromptFragment`、`bindJobRegistry`)同一个形状:调用方不必记得自己
   * 有没有关过,也不必先问一句 `has`。
   *
   * 非法自述抛 `ResourceSpecError`,重复 scheme 抛 `ResourceSchemeTakenError`。
   * 两者都在写表之前抛,所以失败的登记不会留下半张表。
   */
  register(spec: ResourceSpec): () => void {
    assertResourceSpec(spec)
    if (this.specs.has(spec.scheme)) throw new ResourceSchemeTakenError(spec.scheme)

    const frozen = Object.freeze(spec)
    this.specs.set(frozen.scheme, frozen)
    this.notify()

    return () => {
      // 身份判等,不是只判名字:一份自述注销之后,同一个 scheme 可能已经被
      // **另一个**提供者登记上了(插件重装、MCP 重连)。拿旧闭包再关一次不该把
      // 后来者摘掉。幂等也一并由它保证(第二次调用时表里已经不是 `frozen`)。
      if (this.specs.get(frozen.scheme) !== frozen) return
      this.specs.delete(frozen.scheme)
      this.notify()
    }
  }

  has(scheme: string): boolean {
    return this.specs.has(scheme)
  }

  get(scheme: string): ResourceSpec | null {
    return this.specs.get(scheme) ?? null
  }

  /**
   * 全体已登记的资源,**按 scheme 字典序**,数组冻结。
   *
   * 排序不是为了好看:出口是生成的(§4),而生成物的顺序会进提示词、进命令面板、
   * 进 MCP 的 tool list。让它取决于登记先后 = 同一台机器换个装配顺序就换一份
   * system 前缀,而 system 前缀跨会话逐字相同是提示词双通道那条法的前提。
   */
  list(): readonly ResourceSpec[] {
    return Object.freeze([...this.specs.values()].sort((a, b) => (a.scheme < b.scheme ? -1 : a.scheme > b.scheme ? 1 : 0)))
  }

  /** 这个地址属于哪种资源。语法不合、或者没人登记过这个 scheme,都回 `null`。 */
  resolve(ref: string): ResolvedRef | null {
    const parsed = parseRef(ref)
    if (!parsed) return null
    const spec = this.specs.get(parsed.scheme)
    if (!spec) return null
    return { spec, ref: parsed }
  }

  /** 这个地址上有没有这条做法。 */
  opOf(ref: string, op: string): OpSpec | null {
    const resolved = this.resolve(ref)
    return resolved ? own(resolved.spec.ops, op) : null
  }

  /** 这个地址上有没有这条读法。 */
  readOf(ref: string, name: string): ReadSpec | null {
    const resolved = this.resolve(ref)
    return resolved ? own(resolved.spec.reads, name) : null
  }

  /**
   * 表变了就叫一声(登记与注销**都**叫)。给将来按表重建的东西用:AI 的工具面、
   * 命令面板、MCP 出口的 tool list —— 它们都是这张表的投影,表一动就该重投一次。
   *
   * 通知里不带内容:投影方要的是「重读一遍」,不是「谁进谁出」的增量 —— 与 U 线
   * 「无快照,漏序重拉」同一个判断。监听器**不许抛**:通知发生在写表之后,一个
   * 抛出的监听器会把异常带回 `register` 的调用方,而那时表已经改了。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    // 拷一份再遍历:监听器在回调里退订是正常操作(投影方被销毁),直接遍历
    // 活集合会漏掉后面的人。
    for (const listener of [...this.listeners]) listener()
  }
}
