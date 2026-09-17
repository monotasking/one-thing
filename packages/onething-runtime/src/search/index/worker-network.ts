/**
 * 索引 Worker 这条线程上的**出网**:模型下载走不走 app 的代理。
 *
 * 设计:docs/design/search-index-2026-09.md §15.3(2026-09-17 补);事故现场见
 * `worker-data.ts` 那格 `semantic.proxy` 的注释。
 *
 * ## 为什么是「换掉这条线程的 globalThis.fetch」
 *
 * 三条路都试过,前两条真机上不通:
 *
 *  - **`transformers.env` 上给一只自定义 fetch**:3.8.1 **没有这个口**。
 *    `node_modules/@huggingface/transformers/src/utils/hub.js` 的 `getFile()` 直接调
 *    裸 `fetch(urlOrPath, { headers })`,`env` 里也没有 `fetch` / `customFetch` 那一格
 *    (`src/env.js` 的 `TransformersEnvironment` 逐格看过)。所以没得递。
 *  - **给全局 fetch 递 `init.dispatcher`**:本机实测 `fetch failed: invalid
 *    onRequestStart method` —— Node 内建的那份 undici 与 npm 上的 undici 8 不是同一份
 *    代码,`ProxyAgent` 的钩子形状对不上。
 *  - **`undici.setGlobalDispatcher(new ProxyAgent(url))`**:能通,但它**说不出
 *    `bypassRules`** —— 那张表是设置里真有的一格(缺省 `localhost;127.0.0.1;::1;*.local`),
 *    一刀切等于把它扔了。
 *
 * 剩下的这一条既通又说得全:**把这条线程的 `globalThis.fetch` 换成 provider 那只受管
 * fetch**(`providers/bound-fetch.ts` 的 `createOnethingAppFetch`)。绕过判据、代理
 * dispatcher、SOCKS5 那一支全是**同一份实现**,这里一行判断都没有抄。Worker 线程有
 * 自己的 `globalThis`,所以主线程一个字不受影响。
 *
 * ## 两件必须自己处理的事
 *
 *  ① **原来那只 fetch 要留着当 `directFetch`**。受管 fetch 在「该绕过代理」那一支调的
 *     是 `adapters.directFetch ?? fetch` —— 不把原件递进去,它会调到我们刚换上去的
 *     这只自己,当场无限递归。
 *  ② **答复要裹回全局的 `Response`**。npm undici 的 `Response` 不是全局那一个类,而
 *     `hub.js:566` 判的正是 `response instanceof Response`:判不过 → `toCacheResponse`
 *     为假 → **模型不写进磁盘缓存**,每次起 Worker 重下 110MB。所以这里把它按 WHATWG
 *     那几格(status / statusText / headers / body)重新裹一只全局 `Response`。
 *     本机实测:裹之前 `instanceof` 假、裹之后真,`content-length` 与字节数不变。
 *
 * ## 超时:这条路**不设**
 *
 * 用的是 `policy: 'streaming'`(`retry: false`、无 `timeoutMs`)。缺省档那 30s 放在
 * 一次 110MB 的下载上就是「必超时」。
 */

import { getLogger } from '../../logging/index.js'
import {
  createOnethingAppFetch,
  type OnethingFetchFn,
} from '../../providers/bound-fetch.js'
import {
  validateOnethingProxyUrl,
  type OnethingProxySettings,
} from '../../providers/network.js'

const log = getLogger('search.index.worker')

/** `workerData` 里那一格的形(与 `IndexWorkerData['semantic']['proxy']` 同形)。 */
export interface WorkerProxyConfig {
  enabled: boolean
  url: string
  bypassRules?: string
}

/** 全局 `fetch` 形状的最小宿主面 —— 单测拿一只假的塞进来,不碰真 `globalThis`。 */
export interface FetchHolder {
  fetch: OnethingFetchFn
}

/**
 * HuggingFace 的镜像站。**只读环境变量,不加设置项**(国内常用的那条逃生口;
 * 设置极简那条:它不是每个人都要填的必填项)。
 */
export const HF_ENDPOINT_ENV = 'HF_ENDPOINT'

/**
 * npm undici 的答复 → 全局 `Response`。见文件头 ②。
 *
 * 已经是全局那一只就原样返回(没有代理的那一支走的就是原来的 fetch,不该白裹一层)。
 */
export function toGlobalResponse(response: Response): Response {
  if (response instanceof Response) return response
  const source = response as unknown as {
    status: number
    statusText: string
    headers: Headers
    body: ReadableStream<Uint8Array> | null
  }
  // 204 / 304 结构上不许带 body,硬塞会抛 —— 与「裹一层」的意图无关,照规矩给 null。
  const bodyless = source.status === 204 || source.status === 205 || source.status === 304
  return new Response(bodyless ? null : source.body, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers as unknown as HeadersInit,
  })
}

/**
 * 把这条线程的 `fetch` 换成受管的那只。**返回还原函数**(单测与换 Worker 都用得上)。
 *
 * 代理没配 / 关着 / URL 非法 = **一个字都不做**(答一只空还原函数)。URL 非法不抛:
 * 语义召回不该因为代理那一格填错而把整条 Worker 带走 —— 记一条 warn,直连着试。
 */
export function installWorkerProxyFetch(
  proxy: WorkerProxyConfig | undefined,
  holder: FetchHolder = globalThis as unknown as FetchHolder,
): () => void {
  if (proxy?.enabled !== true) return () => undefined
  const validated = validateOnethingProxyUrl(proxy.url)
  if (!validated.valid) {
    log.warn('proxy setting is not a usable URL; the model download goes direct', {
      fields: { error: validated.error },
    })
    return () => undefined
  }

  const settings: OnethingProxySettings = {
    enabled: true,
    url: validated.normalizedUrl,
    ...(proxy.bypassRules !== undefined ? { bypassRules: proxy.bypassRules } : {}),
  }
  const original = holder.fetch
  const managed = createOnethingAppFetch(
    // 无超时、不重试:下载 110MB 与一次 provider 调用不是同一种请求(文件头末段)。
    { policy: 'streaming', proxy: settings },
    {
      // ① 见文件头:绕过代理那一支要调**原件**,不是我们刚换上去的这只。
      directFetch: original,
      // 受管 fetch 的失败出口是个 `console.error` 形状的鸭子口;这里把它接到日志门面上
      // (仓顶「新代码不许 console.*」)。
      logger: {
        error: (_message: unknown, detail: unknown) => {
          log.warn('model download request failed', { fields: { detail } })
        },
      },
    },
  )

  holder.fetch = async (input, init) => toGlobalResponse(await managed(input, init))
  log.info('model downloads in this worker go through the app proxy', {
    fields: { proxy: settings.url, bypassRules: settings.bypassRules ?? '' },
  })
  return () => { holder.fetch = original }
}

/**
 * **取消一次模型下载**(2026-09-17)。
 *
 * ## 为什么它必须长在 `fetch` 上
 *
 * `@huggingface/transformers` 3.8.1 **没有 signal 口**:`hub.js` 的 `getFile()` 调的是
 * 裸 `fetch(url, { headers })`,`pipeline()` 的参数表里也没有一格能递进去。所以「停」
 * 这件事只有一个落点 —— 这条线程的全局 `fetch`,把 signal 替调用方塞进去。
 *
 * 这与代理那一半是**两层**,不是一件事:代理换的是「这一发怎么出去」,这一层加的是
 * 「这一发还要不要」。所以它装在代理**之上**(`worker.ts` 里先代理后它),于是代理
 * 配没配都一样能取消 —— 直连也要停得下来。
 *
 * ## 「这条线程上别的请求呢」
 *
 * 没有别的:索引 Worker 这条线程上会出网的只有模型下载。真长出第二种时,这里要换成
 * 按请求带 signal(那时 `begin()` 就该返回一只 signal 给调用方自己递),而不是继续
 * 往全局上挂。这一句写在这儿,就是那天的判据。
 *
 * `init.signal` 已经有的那一发**不覆盖** —— 调用方自己说的话优先。
 */
export class WorkerDownloadSignal {
  private controller: AbortController | undefined

  /** 包在当前 `holder.fetch` 之上。**返回还原函数**(单测用)。 */
  install(holder: FetchHolder = globalThis as unknown as FetchHolder): () => void {
    const original = holder.fetch
    holder.fetch = async (input, init) => {
      const signal = init?.signal ?? this.controller?.signal
      return await original(input, signal === undefined ? init : { ...init, signal })
    }
    return () => { holder.fetch = original }
  }

  /** 开一次可取消的活。返回那只 signal —— 实现方也可以自己拿去赛 `Promise.race`。 */
  begin(): AbortSignal {
    this.controller = new AbortController()
    return this.controller.signal
  }

  /** 停。没在跑就什么都不做(取消一次没开始的下载不是错)。 */
  abort(): void {
    this.controller?.abort()
    this.controller = undefined
  }

  /** 这一次干完了(成了或败了都算)。此后的请求不再带这只 signal。 */
  end(): void {
    this.controller = undefined
  }
}

/**
 * 镜像站那一格。`HF_ENDPOINT` 设了就赋给 `env.remoteHost`,没设就不碰。
 *
 * 住在这个文件而不是嵌入器里,理由与代理同一条:**它是「这台机器怎么上网」**,
 * 不是「用哪个模型」。嵌入器换一条(拍点癸 b)这两件事都不该跟着换。
 */
export function resolveHuggingFaceEndpoint(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[HF_ENDPOINT_ENV]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
