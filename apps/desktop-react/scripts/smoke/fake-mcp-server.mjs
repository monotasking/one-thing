#!/usr/bin/env node
/**
 * 冒烟用的**最小 MCP stdio 服务器**(C1,方案
 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §3 的 C1 行)。
 *
 * 它存在的唯一理由:让「壳起来一秒内退出,MCP 子进程不许留下」这条真机门有东西
 * 可测。没有它,门在一台没配 stdio MCP 的机器上是空转的 —— 而空转的门比没有门更坏。
 *
 * 只实现握手需要的那几句 JSON-RPC(帧格式是换行分隔的 JSON,MCP stdio 传输的规定):
 *  · `server/discover` → 明确的 -32601。2026-07-28 版本协商的探针发的就是它,
 *    收到「方法不存在」= 定论式的"这是台旧服务器",客户端立刻退回 legacy
 *    `initialize` 握手,不必干等探针那 10s 超时。
 *  · `initialize` → 回客户端报上来的协议版本 + 三件能力。
 *  · `tools/list` / `resources/list` / `prompts/list` → 空表。
 *  · 其余 → -32601。
 *
 * 进程自己**永不退出** —— 门要验的正是"谁来杀它"。
 *
 * **stdin 关掉也不退**(这一句是判据本身,不是懒):父进程一死,管道就断,一个
 * 「stdin end 就自杀」的假服务器会把孤儿伪装成没孤儿 —— 门于是恒绿。真实的 stdio
 * MCP 服务器什么形状都有,而这道门要抓的正是最坏的那种。正常收摊靠
 * `StdioClientTransport.close()` 发的 SIGTERM(不拦,默认行为杀掉)。
 * 兜底一个 120s 自毁,免得门自己炸了以后在机器上留尸体。
 *
 * 命令行上带一个 `--marker <token>`,好让门用 `pgrep -f` 精确地只数这一次跑起来的那些。
 */
import { createInterface } from 'node:readline'

const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function resultFor(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params?.protocolVersion === 'string'
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'onething-smoke-fake-mcp', version: '0.0.0' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: [] }
    case 'resources/list':
      return { resources: [] }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'prompts/list':
      return { prompts: [] }
    default:
      return null
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  // 通知没有 id,不回话。
  if (message.id === undefined || message.id === null) return

  const result = resultFor(message.method, message.params)
  if (result === null) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, result })
})

// 活着等人来杀。stdin 断了也不走 —— 见文件头。
setTimeout(() => process.exit(0), 120_000)
setInterval(() => {}, 1 << 30)
