import { createHttpTransport, createOnethingClient, type OnethingClient } from '@onething/backend-client'
import { settingsRouter, type AppSettings } from '@shared/ipc/settings'
import type { HostConnectionResult } from './host-connection.js'

/**
 * **主进程自己当一台客户端**(第④步批 1,决策 D284;批 2b 起是主进程与后端之间唯一的数据通路)。
 *
 * 后端是 Electron 拉起的子进程(`./backend-process.ts`),主进程有几件事要问它:页面重载时让终端勾销欠着的
 * 流控账(`terminal.detachAll`)、内置浏览器认领 `browser:`(`resources.mountShell`)、旧凭证先读后交
 * (`spaces.handOverLegacyCredentials`)、订设置变了没有(下面那只 feed)。全部与渲染层同一条路:
 * `POST /api/rpc` + `GET /api/events`,地址与 token 就是交给渲染层的那一份(`host:connection` 的同一个承诺)。
 *
 * 惰性建、只建一次:第一次有人要的时候才等连接落定。连不上(`ok: false`)就交 `undefined`,调用方当作
 * 「这件事这一次做不成」。后端崩了重拉时地址与 token 不变(判词在 `backend-process.ts` 文件头),所以这只
 * 客户端不必重建 —— SSE 由传输自己重连。
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

export type SettingsListener = (settings: AppSettings) => void

export interface SettingsFeed {
  /** 订「设置此刻是什么样」:连上后先叫一次,之后每次 `settings:changed` 再叫。返回退订(幂等)。 */
  subscribe(listener: SettingsListener): () => void
  /** 最近一次读到的那一份(还没读到 = `undefined`)。 */
  current(): AppSettings | undefined
  /** 停掉事件订阅。幂等。 */
  dispose(): void
}

export interface SettingsFeedLogger {
  warn(msg: string, fields?: Record<string, unknown>, error?: unknown): void
}

/**
 * **主进程那几处「设置变了就重套」的订阅源**(第④步批 2b,§2.3 第 15 条)。
 *
 * 从前代理重套(`./proxy-settings.ts`)、CDP 旗文件(`browser/cdp-settings.ts`)、浏览器身份名册
 * (`browser/profiles.ts`)三处串在后端进程内那只 `settings:changed` 单槽广播器上;后端出了这个进程,那只
 * 广播器就不在这里了。改成订 `GET /api/events` 上同名的全局事件 —— **但不读它的载荷**:那条 SSE 上它是另一种
 * 脱敏过的形状(`@shared/events/global-events.ts` 的判词),所以收到就打一次 `settings.getSettings` 取整份,
 * 再交给原来那几只处理函数(它们本来就收一份设置对象)。连接重新连上(后端重拉过)也重读一次 —— 断线那一段
 * 里改过的设置不会有第二条事件。
 *
 * 一次读失败只记一行:下一条事件或下一次重连会再读。
 */
export function createSettingsFeed(getClient: () => Promise<OnethingClient | undefined>, log: SettingsFeedLogger): SettingsFeed {
  const listeners = new Set<SettingsListener>()
  let latest: AppSettings | undefined
  let disposed = false
  const teardown: Array<() => void> = []
  let reading: Promise<void> | undefined
  let again = false

  const read = (client: OnethingClient): void => {
    if (disposed) return
    if (reading) { again = true; return }
    reading = client.api(settingsRouter).getSettings({})
      .then(answer => {
        if (disposed || !answer.success || !answer.settings) return
        latest = answer.settings
        for (const listener of [...listeners]) {
          try { listener(answer.settings) } catch (error) { log.warn('settings listener failed', undefined, error) }
        }
      })
      .catch((error: unknown) => { log.warn('reading settings over rpc failed', undefined, error) })
      .finally(() => {
        reading = undefined
        if (again) { again = false; read(client) }
      })
  }

  void getClient().then(client => {
    if (!client || disposed) return
    teardown.push(client.events.onAny(event => {
      if (event.name === 'settings:changed') read(client)
    }))
    let previous = client.events.status()
    teardown.push(client.events.onStatusChange(status => {
      if (status === 'live' && previous === 'reconnecting') read(client)
      previous = status
    }))
    read(client)
  })

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (latest) {
        try { listener(latest) } catch (error) { log.warn('settings listener failed', undefined, error) }
      }
      return () => { listeners.delete(listener) }
    },
    current: () => latest,
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of teardown.splice(0)) {
        try { off() } catch { /* 一条退订炸了不该拦住后面那些 */ }
      }
      listeners.clear()
    },
  }
}
