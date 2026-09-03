/**
 * 冒烟探针 —— `scripts/smoke-core-boot.mjs` 打它、跑它(A1-a,2026-08-31)。
 *
 * 它验的是**构建链**,不是产品行为:`electron/main.ts` 那条 import 把整棵
 * core/runtime/backend 拉进一个 CJS bundle,而那棵树里有四处东西 esbuild 默认
 * 处理不了(`?raw`、`import.meta.url`、三个原生模块、`@shared`)。任何一处配漏,
 * 症状都是**模块求值期**炸或者跑起来才发现某个能力是假的 —— 单测看不见,
 * 只有真跑一遍产物才看得见。
 *
 * 四条读数,少一条即红:
 *   READY_MS  —— `createOnethingBackend` 到 ready 的毫秒数(门线 1000ms)。
 *   HTTP      —— 真起一次内嵌 HTTP/SSE 面,真发一次带 Bearer 的 fetch 打
 *                `/api/capabilities`。这一条同时盖住 undici(在 Electron 主进程下
 *                是首验)和 embed 那条链。
 *   COLLAB    —— capabilities 里的 `collabRooms`,即 `collab: true` 这颗必落件
 *                有没有真的落到装配上。
 *   PTY       —— `require('node-pty')`。它是 external,所以这一句问的是
 *                「运行时真解析得到吗」,不是「打进去了吗」。
 *
 * 两个泳道跑同一份产物:纯 node 与 Electron 主进程。后者是 A1 的首验项 ——
 * A0 只在 node 下跑过,Electron 的 net stack 与 node 的不是同一套。
 */
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createOnethingBackend } from '@onething/backend/backend.js'
import {
  startEmbeddedOnethingHttpServer,
  stopEmbeddedOnethingHttpServer,
} from '@onething/backend/server/embed.js'
import { readHttpDiscovery, removeHttpDiscovery } from '@onething/backend/server/discovery.js'
import { configureLogging } from '@onething/backend/wiring/logging/index.js'

/**
 * `configureLogging` 之后 `console.*` 与 stdout 都被 LegacyConsoleSink 收进账本
 * (迁移期的设计),所以读数要用**劫持之前**绑住的那只写手,否则脚本侧一个字也收不到。
 */
const emit = process.stdout.write.bind(process.stdout)

/**
 * 顺带把 ② 那个 shim 也验了:`createRequire(import.meta.url)` 正是 `pty-backend.ts`
 * 与 `kws/engine.wiring.ts` 顶层那一句。banner 配漏时这一行**在模块求值期**就抛
 * ERR_INVALID_ARG_VALUE —— 探针连第一条读数都印不出来,症状与真实故障逐字相同。
 */
const requireRuntime = createRequire(import.meta.url)

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

async function probe(): Promise<void> {
  const started = Date.now()
  configureLogging({ fileBaseName: 'shell', src: 'main' })
  const backend = await createOnethingBackend({
    // 探针不是宿主:它验的是构建链,不接任何 Electron 能力(壳自己那张表在
    // `electron/host-ports.ts`)。两件必填项给空对象 —— 与"从未注入"逐字相同。
    // 唯一跟着壳走的一格是 `localTrust`(B3):探针要验的正是"装配之后能力位就是
    // 真的",而那一位(`localFileSystem`)读的就是这句声明。
    host: {
      storePath: {},
      sandbox: {},
      auth: null,
      logging: null,
      shell: null,
      voice: null,
      terminal: null,
      skillsEnvironment: null,
      todoPlan: null,
      scratchpad: null,
      plugins: null,
      gateway: null,
      settings: null,
      evals: null,
      mcp: null,
      localTrust: { origin: 'desktop-embedded' },
    },
    toolRegistry: 'full',
    promptVersion: true,
    collab: true,
    sessionSkills: true,
    sender: new NoopSender() as never,
  })
  emit(`READY_MS ${Date.now() - started}\n`)

  const embedded = await startEmbeddedOnethingHttpServer(backend, { owner: 'shell' })
  emit(`OWNER ${readHttpDiscovery()?.owner ?? 'missing'}\n`)

  const response = await fetch(`${embedded.url}/api/capabilities`, {
    headers: embedded.token ? { authorization: `Bearer ${embedded.token}` } : {},
  })
  emit(`HTTP ${response.status}\n`)
  const capabilities = (await response.json()) as {
    collabRooms?: boolean
    localFileSystem?: boolean
    terminal?: boolean
    pluginsManage?: boolean
  }
  emit(`COLLAB ${String(capabilities?.collabRooms)}\n`)
  // B3:三位从后端事实推导出来的能力位。壳上的期望是 true / false / false ——
  // 信任在宿主表里声明了,终端广播器与插件管理器这个壳都还没有。
  emit(
    `CAPS localFileSystem=${String(capabilities?.localFileSystem)}`
    + ` terminal=${String(capabilities?.terminal)}`
    + ` pluginsManage=${String(capabilities?.pluginsManage)}\n`,
  )

  let pty = 'missing'
  try {
    const nodePty = requireRuntime('node-pty') as { spawn?: unknown }
    pty = typeof nodePty.spawn === 'function' ? 'ok' : 'unexpected-shape'
  } catch (error) {
    pty = `error:${(error as Error).message.slice(0, 120)}`
  }
  emit(`PTY ${pty}\n`)

  await backend.dispose()
  await stopEmbeddedOnethingHttpServer()
  removeHttpDiscovery()
  emit('DONE\n')
}

async function run(): Promise<number> {
  try {
    await probe()
    return 0
  } catch (error) {
    emit(`PROBE_ERROR ${(error as Error)?.stack ?? String(error)}\n`)
    return 1
  }
}

if (process.versions.electron) {
  // Electron 泳道:窗口一个都不开,只借 app 的身份与那套 net stack。
  const { app } = requireRuntime('electron') as typeof import('electron')
  void app.whenReady().then(async () => {
    app.exit(await run())
  })
} else {
  void run().then(code => process.exit(code))
}
