/**
 * 一个最小的 OpenAI 兼容假 provider(`POST /v1/chat/completions`,SSE),给
 * `gate-vue-host.mjs` / `gate-web-shell.mjs` 共用。
 *
 * 完整版本(带场景矩阵、工具调用、压缩摘要)在 `scripts/shadow-battery.mjs`;
 * 这里只要「收一条请求、吐一句可识别的流式回答」,不复制那份复杂度 ——
 * 两个门要证的是「壳的推送链路通不通」,不是 provider 语义本身。
 */
import http from 'node:http'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {number} port
 * @param {string} replyText 助手回答的整段文字(会被切成几片流式送出)。
 */
export function startFakeProvider(port, replyText) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = obj => {
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
      // 切成 3 片流式送出 —— 证的是「逐片到达也能在屏幕上拼回整句」,不是一次性吐完。
      const pieces = 3
      const size = Math.ceil(replyText.length / pieces)
      for (let i = 0; i < replyText.length; i += size) {
        if (res.destroyed) break
        send(frame({ content: replyText.slice(i, i + size) }))
        await sleep(30)
      }
      if (!res.destroyed) {
        send(frame({}, 'stop'))
        res.write('data: [DONE]\n\n')
      }
      res.end()
    })
  })
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/** settings.json 里 `ai` 那一段(deepseek 指向假 provider,钥匙走环境变量)。 */
export function fakeProviderAiSettings(mockPort) {
  return {
    provider: 'deepseek',
    temperature: 0.6,
    providers: {
      deepseek: {
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        model: 'deepseek-chat',
        selectedModels: ['deepseek-chat'],
        enabled: true,
        modelCapabilitiesByModel: {
          'deepseek-chat': { tools: false, reasoning: false, vision: false },
        },
      },
    },
    customProviders: [],
    modelCatalog: {},
  }
}

/** 钥匙走环境变量,不写进 settings.json(见 shadow-battery.mjs 同名注释)。 */
export const FAKE_PROVIDER_ENV = { DEEPSEEK_API_KEY: 'sk-gate' }
