/**
 * 一个**可指定段数**的假 provider(OpenAI 兼容 `POST /v1/chat/completions`,SSE)。
 *
 * ── 为什么不用仓根那一份 ──────────────────────────────────────────────────
 * `scripts/lib/gate-fake-provider.mjs` 把段数写死成 3(`const pieces = 3`),
 * 它证的是「逐片到达也能拼回整句」,3 段就够。而交互预算里有一条是
 * **「流式 20 段 delta 期间零 ≥50ms 长帧」** —— 那要的是 20 次真的到达、
 * 20 次真的提交、20 次真的排版,3 段说不出这句话。
 *
 * 抄过来的只有**服务器那一半**(段数是它唯一的参数);`settings.json` 里那段
 * `ai` 配置与钥匙的环境变量仍然从仓根那一份 import —— 配置对不上是这类门最常见
 * 的哑火,不许有第二份。
 */
import http from 'node:http'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {number} port 0 = 让内核挑一个空口
 * @param {string} replyText 助手回答的整段文字
 * @param {{pieces?: number, gapMs?: number}} [options]
 *   `pieces` 切成几段(缺省 3,与仓根那份一致);`gapMs` 段间隔(缺省 30ms)。
 */
export function startChunkedFakeProvider(port, replyText, options = {}) {
  const pieces = Math.max(1, options.pieces ?? 3)
  const gapMs = options.gapMs ?? 30
  const server = http.createServer((req, res) => {
    // 请求体读掉即可 —— 这台假 provider 不看内容,但不排干 `end` 不会来。
    req.resume()
    req.on('end', async () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (obj) => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finishReason = null) => ({
        id: 'chatcmpl-gate',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })
      const size = Math.max(1, Math.ceil(replyText.length / pieces))
      for (let at = 0; at < replyText.length; at += size) {
        if (res.destroyed) break
        send(frame({ content: replyText.slice(at, at + size) }))
        await sleep(gapMs)
      }
      if (!res.destroyed) {
        send(frame({}, 'stop'))
        res.write('data: [DONE]\n\n')
      }
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
