/**
 * K5-a —— 一台外部 server 这一 scheme 的实现
 * (`docs/design/atom-2026-09.md` §9 K5「外部」的第一个驱动:**MCP 投影驱动**)。
 *
 * 自述在产品层(`@onething/runtime/mcp/resource-spec` 的 `projectMcpResource`),
 * 实现在这里 —— 与 `music` / `session` / `dir` 三对逐字同一条纪律。差别只有一条:
 * 这一份自述是**算出来的**,所以 provider 的构造参数里带着投影的产物(自述 + op
 * 名对照表),而不是一个字面量。
 *
 * ## 一件事不许有两条实现路
 *
 * MCP 工具今天已经以 `McpTool`(`runtime/toolkit/families/external.ts`)进了工具
 * 目录给模型用,**这一单一个字都不动它**。这里要的是另外四条路(RPC / CLI /
 * 插件 / 将来的 MCP 出口)也够得着同一台 server,而不是给模型第二只工具 ——
 * 后者由自述里那格 `exposure.aiTool: false` 挡住(`catalog-sync.ts` 读它)。
 *
 * 「不许两条实现路」落到代码上是三件具体的事,每一件都是**复用**而不是抄:
 *   · 调用走 `MCPManager.callTool(serverId, toolName, args)` —— `McpTool.apply`
 *     经 `executeMCPTool` → `executeMCPBridgeTool` 最后落到的就是这一行,中间那两
 *     层做的是「把扁平 id 解析回 serverId + toolName」,而这里从投影那一刻起就已经
 *     有这两样了;
 *   · 回执文本走 `withMCPResultOutputText` + `mcpResultText`,两只都是那条路自己
 *     用的函数(前者填 `output`,不填的下场是图片的 base64 被 JSON 化进正文再当
 *     图片附一遍,同一份字节收两次费);
 *   · 效果是 `mcp` 一类,与 `McpTool.spec.effects` 逐字相同 —— 权限只认效果,两条
 *     路对同一台 server 说的必须是同一句话。
 *
 * ## 授权资源名为什么带 serverId
 *
 * `makeEffect('mcp', [...])` 的资源名是 grant 的键。`McpTool` 那一侧的规矩是
 * **按 server 归属,不按裸工具名**(`buildMcpPermissionPlan`:`mcp:<serverId>:<tool>`),
 * 理由是两台 server 可能报同名工具,而一次授权不该跨 server 生效。这里的资源名是
 * 地址(`mcp-<id>:server`),而地址的左半边**就是**那台 server —— 同一条保证,由
 * 地址系统自己给出,不必再拼一遍字符串。
 */

import type {
  ResourceProvider,
  ResourceReadContext,
  ResourceRef,
  ResourceSpec,
} from '@onething/core/resource'
import { planFromSpec } from '@onething/core/resource'
import type { Intent, PlanContext, Result, RunContext } from '@onething/core/toolkit'
import type { JsonObject } from '@onething/core'
import type { MCPToolCallResult } from '@onething/core/mcp'
import { withMCPResultOutputText } from '@onething/core/mcp'
import { mcpResultText } from '@onething/runtime/toolkit'
import {
  MCP_RESOURCE_SINGLETON_PATH,
  type McpResourceProjection,
} from '@onething/runtime/mcp/resource-spec'

/**
 * 这只 provider 看得见的客户端面 —— **一件事**,不是整只 `MCPManager`。
 *
 * 窄到一个方法是有意的:单测注入一只函数就够,而生产上传进来的仍然是那台进程
 * 单例的 `callTool`。它也把「这只 provider 会不会顺手去连 / 去断一台 server」这个
 * 问题在类型上答死了 —— 连接的生命周期归 `McpSubsystem`,这里只打电话。
 */
export interface McpResourceCallPort {
  callTool(serverId: string, toolName: string, args: JsonObject): Promise<MCPToolCallResult>
}

/** 地址指着这台 server 之外的东西。单例只有一个路径,写别的是说错了不是多写了。 */
export class McpResourceRefMismatchError extends Error {
  constructor(scheme: string, got: string) {
    super(`${scheme} has a single instance at ${scheme}:${MCP_RESOURCE_SINGLETON_PATH}, not ${scheme}:${got}`)
    this.name = 'McpResourceRefMismatchError'
  }
}

/**
 * 工具报错。
 *
 * **`success: false` 与 `isError: true` 都算报错**,而且都落 `Outcome.failed`:
 * 前者是「这通电话没打通」(server 断了 / 工具不存在),后者是 MCP 协议里工具
 * 自己说「我失败了」。两者对调用方是同一句话 —— 这次做没做成 —— 而把工具自报的
 * 失败塞进一个 `ok` 里,账本上就会留下一次成功。带出去的文案是回执自己写的,
 * 这里不发明。
 */
export class McpResourceCallFailedError extends Error {
  constructor(op: string, reason: string) {
    super(reason)
    this.name = 'McpResourceCallFailedError'
    this.op = op
  }

  readonly op: string
}

/** `plan` 交给 `apply` 的载荷:已经解析好的这一次要打给谁。 */
export interface McpOpPayload {
  readonly op: string
  readonly toolName: string
  readonly args: JsonObject
}

export class McpResourceProvider implements ResourceProvider<McpOpPayload> {
  readonly spec: ResourceSpec
  /** 哪台 server。装配层按它成批注销,`apply` 按它打电话。 */
  readonly serverId: string
  /** 这份投影的指纹。装配层拿它判「工具表变了没有」(§10.2)。 */
  readonly fingerprint: string

  private readonly toolNames: ReadonlyMap<string, string>
  private readonly port: McpResourceCallPort

  constructor(serverId: string, projection: McpResourceProjection, port: McpResourceCallPort) {
    this.serverId = serverId
    this.spec = projection.spec
    this.toolNames = projection.toolNames
    this.fingerprint = projection.fingerprint
    this.port = port
  }

  /**
   * 读:没有。
   *
   * §3 那一行写的就是「读法与事件为空」,所以自述里 `reads` 是空表,而空表意味着
   * 两条读路(内核的 `read`、模型经 `ResourceTool` 的那一支)都在**进到这里之前**
   * 就被同一只校验挡住了(`describeUnknownResourceReadProblem`)。留一句诚实的错
   * 而不是返回 `undefined`:这个方法是公开的,手搓一次调用的人该当场听见。
   */
  async read(name: string, _ref: ResourceRef | null, _query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    throw new TypeError(`Resource ${this.spec.scheme} has no read named ${JSON.stringify(name)}`)
  }

  async plan(op: string, ref: ResourceRef | null, params: unknown, _ctx: PlanContext): Promise<Intent<McpOpPayload>> {
    this.assertRef(ref)
    const toolName = this.toolNames.get(op)
    // `planFromSpec` 自己会对不在自述里的 op 抛;先查对照表是因为**这里**还有一种
    // 自述里有、对照表里没有的可能(投影与实现读的是同一份产物,所以今天不可能),
    // 而那种情况下抛一句「没有这条做法」比抛一句「工具名是 undefined」诚实。
    if (!toolName) throw new TypeError(`Resource ${this.spec.scheme} has no op named ${JSON.stringify(op)}`)
    const declared = Object.prototype.hasOwnProperty.call(this.spec.ops, op) ? this.spec.ops[op] : undefined
    const payload: McpOpPayload = { op, toolName, args: (params ?? {}) as JsonObject }
    // 效果按自述的**静态上界**造:一次外部调用的具体效果只有 server 知道,本地
    // 分不出档,所以上界就是它的具体效果(与 `ShellResourceProvider` 同一条)。
    return planFromSpec<McpOpPayload>(
      this.spec,
      op,
      ref,
      payload,
      declared ? { title: declared.title } : undefined,
    )
  }

  async apply(_op: string, intent: Intent<McpOpPayload>, ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    const answered = withMCPResultOutputText(
      await this.port.callTool(this.serverId, payload.toolName, payload.args),
    )
    if (!answered.success || answered.isError) {
      throw new McpResourceCallFailedError(
        payload.op,
        answered.error ?? answered.output ?? `${payload.toolName} failed`,
      )
    }
    ctx.emit({ type: 'annotate', title: payload.toolName, details: { op: payload.op } })
    return {
      content: [{ type: 'text', text: mcpResultText(answered) }],
      details: { op: payload.op, tool: payload.toolName },
    }
  }

  /** 单例地址。缺席 = 就是它;给了别的 = 当场说不。 */
  private assertRef(ref: ResourceRef | null): void {
    if (!ref || !ref.path) return
    if (ref.path !== MCP_RESOURCE_SINGLETON_PATH) {
      throw new McpResourceRefMismatchError(this.spec.scheme, ref.path)
    }
  }
}
