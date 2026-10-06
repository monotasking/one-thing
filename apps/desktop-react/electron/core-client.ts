import { createHttpTransport, createOnethingClient, type OnethingClient } from '@onething/backend-client'
import type { HostConnectionResult } from './host-connection.js'

/**
 * **主进程自己当一台客户端**(第④步批 1,决策 D284)。
 *
 * 主进程有几件事要问后端(今天只有一件:页面重载时让终端勾销欠着的流控账,`terminal.detachAll`)。
 * 从前它直接调后端的模块函数 —— 后端就在这个进程里,调得到;第④步批 2 后端搬进子进程,那一句会落在
 * 错的进程里。所以现在就改成与渲染层同一条路:`POST /api/rpc`,地址与 token 就是交给渲染层的那一份
 * (`host:connection` 的同一个承诺)。批 2 那一天这只文件一个字不用改。
 *
 * 惰性建、只建一次:第一次有人要的时候才等连接落定。连不上(`ok: false`)就交 `undefined`,调用方当作
 * 「这件事这一次做不成」——它们都是加速器,不是正确性的前提。
 */
export function createCoreClientGetter(connection: Promise<HostConnectionResult>): () => Promise<OnethingClient | undefined> {
  let pending: Promise<OnethingClient | undefined> | undefined
  return () => {
    pending ??= connection.then(result => result.ok
      ? createOnethingClient({ transport: createHttpTransport({ baseUrl: result.baseUrl, ...(result.token ? { token: result.token } : {}) }) })
      : undefined)
    return pending
  }
}
