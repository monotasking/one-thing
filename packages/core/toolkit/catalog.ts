/**
 * §3 内核 —— `Catalog`:全体已注册工具的目录。
 *
 * 它只回答"系统里有哪些工具",不回答"这一回合看得见谁"(那是 `Surface`)。
 *
 * 目录是**可变**的:插件卸载、MCP 断连都会摘工具(`unregister`)。不可变的是
 * `Surface` —— 它每回合从当下的目录解析一次,解析完就不再变。
 * 另外它是 `prepare()` 的唯一管理者:懒初始化今天散在各处(MCP 连接在执行前
 * 现连、异步 schema 在第一次列表时现拉),各自重复实现"只跑一次"且都不并发安全。
 */

import type { Tool } from './tool.js'
import type { PrepareEnv } from './spec.js'

export class Catalog {
  private readonly tools = new Map<string, Tool>()
  private readonly preparing = new Map<string, Promise<void>>()
  private readonly prepared = new Set<string>()

  register(tool: Tool): this {
    const id = tool.spec.id
    if (this.tools.has(id)) throw new Error(`Tool already registered: ${id}`)
    this.tools.set(id, tool)
    return this
  }

  /**
   * 摘掉一个工具(插件卸载 / MCP 断连)。初始化记录一并清掉:同名工具下次装回来
   * 是**另一个实例**,不该继承上一次的 prepare 结果。
   */
  unregister(id: string): boolean {
    this.preparing.delete(id)
    this.prepared.delete(id)
    return this.tools.delete(id)
  }

  has(id: string): boolean {
    return this.tools.has(id)
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id)
  }

  all(): readonly Tool[] {
    return [...this.tools.values()]
  }

  get size(): number {
    return this.tools.size
  }

  /**
   * 并发安全靠"先把 promise 记进表,再 await":第二个调用者拿到的是同一个 promise,
   * 不会再跑一次 prepare。失败时把记录**删掉** —— 一次 MCP 连接超时不该把这个
   * 工具永久毒死,下一次调用应该能重试。
   */
  async ensurePrepared(id: string, env: PrepareEnv = {}): Promise<void> {
    const tool = this.tools.get(id)
    if (!tool) throw new Error(`Unknown tool: ${id}`)

    const existing = this.preparing.get(id)
    if (existing) return existing

    const pending = (async () => {
      try {
        await tool.prepare(env)
        this.prepared.add(id)
      } catch (error) {
        this.preparing.delete(id)
        throw error
      }
    })()
    this.preparing.set(id, pending)
    return pending
  }

  /** 已经初始化**完成**没有(在跑的中途不算)。只给测试与诊断用。 */
  isPrepared(id: string): boolean {
    return this.prepared.has(id)
  }
}
