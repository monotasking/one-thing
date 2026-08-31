#!/usr/bin/env node
/**
 * 凭证与协作取证门(A1-c,2026-08-31)—— A1 换心**为什么**是换心,证据在这里。
 *
 * ── 它在证什么 ──────────────────────────────────────────────────────────
 * D0 那版壳没有活的 core 时 spawn `dist/server/main.js`。那个子进程能读同一个
 * store、能建会话、能开 SSE —— 看上去什么都对。但 OAuth 令牌与 API key 是按
 * safeStorage 加密落盘的,而 safeStorage 绑 **app 身份**(macOS 上是 Keychain 的
 * ACL)。一个纯 node 子进程没有那个身份,`configureAuthHost` 那个口它也注入不了。
 *
 * 症状比「读不出来」更严重,而且是本批实测出来的:装配序列里挂着一次性迁移
 * `migrateProviderConfigToDefaultSpace`(把 settings.ai 的凭证搬进 default 空间的
 * 凭证池)。**谁先启动谁跑这次迁移**,而迁移是照自己手上的加密能力写的 ——
 *
 *   壳(有 app 身份)  → `workspaces/default/credentials.json` 的
 *                        `"encryption": "safeStorage"`,整包是密文。
 *   spawn 的 node 子进程 → 同一份文件写成 `"encryption": "none"`,
 *                        **API key 与 OAuth 令牌明文躺在盘上**。
 *
 * 所以这不只是「新壳看不见 provider」,是「让没有身份的进程当 core 会把用户的
 * 凭证降级成明文」。A1 把装配放回拿着 Electron app 身份的那个进程里。
 *
 * ── 为什么是拷贝而不是生产 store ────────────────────────────────────────
 * 「验证不改状态」(判例 feedback_no_mutation_in_verification):这道门会触发上面
 * 那次**不可逆**的迁移。所以只从生产 store **只读**拷出凭证相关的那几份文件到一次性
 * 目录,别的一概不带。Keychain 的 ACL 认的是 app 身份不是文件路径,拷贝件照样解得开。
 *
 * ── 三条断言(实验组 = 壳)──────────────────────────────────────────────
 *   ① `providers.list` 非空 —— provider 目录读得出来。
 *      (注:对照组这一条也是绿的 —— provider 注册表由 `configureAppProviderRegistry`
 *       装配,每个宿主都跑。目录与凭证是两件事,分野在 ②。)
 *   ② default 空间的凭证池 `encryption === 'safeStorage'`,而且**解得开**:
 *      在壳自己的主进程里解一次,里面带着源 store 那个 provider 的 oauth 凭证。
 *      对照组同一份源料写出来的是 `encryption: 'none'` —— 这一行就是分野。
 *   ③ `GET /api/capabilities` 的 `collabRooms === true` —— `collab: true` 这颗
 *      必落件落到了装配上。
 *
 * 跑法:`node scripts/gate-credentials.mjs [--source <生产 store 路径>]`
 * (默认 `ONETHING_CREDENTIALS_SOURCE_STORE` || `~/.onething-dev` || `~/.onething`)。
 * 源 store 里没有任何加密凭证时,②**跳过并明说**,不假装绿。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/**
 * 从生产 store 拷过来的东西 —— **只有凭证这条链要的**。一个都不能多:
 * sessions / sqlite / media 与本门无关,拷它们只会让门变慢变脆。
 * `workspaces/` 带上是因为源 store 可能**已经迁过**了(那时凭证已在池子里)。
 */
const CREDENTIAL_FILES = ['settings.json', 'oauth-tokens.json']
const CREDENTIAL_DIRS = ['workspaces']
/** 与 `@onething/runtime/spaces/types` 的 `DEFAULT_SPACE_ID` 同值。 */
const DEFAULT_SPACE_ID = 'default'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

function skip(message) {
  console.log(`  ⊘ 跳过:${message}`)
}

function resolveSourceStore() {
  const flagIndex = process.argv.indexOf('--source')
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1]
  if (process.env.ONETHING_CREDENTIALS_SOURCE_STORE) return process.env.ONETHING_CREDENTIALS_SOURCE_STORE
  for (const candidate of ['.onething-dev', '.onething']) {
    const dir = path.join(homedir(), candidate)
    if (existsSync(path.join(dir, 'settings.json'))) return dir
  }
  return path.join(homedir(), '.onething')
}

/** 只读地把凭证相关的几份东西复制进一次性 store。源 store 一个字节都不改。 */
async function materializeStore(source) {
  const store = await mkdtemp(path.join(tmpdir(), 'a1-creds-'))
  for (const file of CREDENTIAL_FILES) {
    const from = path.join(source, file)
    if (existsSync(from)) copyFileSync(from, path.join(store, file))
  }
  for (const dir of CREDENTIAL_DIRS) {
    const from = path.join(source, dir)
    if (existsSync(from)) cpSync(from, path.join(store, dir), { recursive: true })
  }
  return store
}

/** 源 store 里哪些 provider 真有一份 oauth 密文 —— ② 要对着它问,不对着空气问。 */
function encryptedOAuthProviders(store) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(store, 'oauth-tokens.json'), 'utf-8'))
    return Object.entries(parsed)
      .filter(([, value]) => typeof value === 'string' && value.length > 64)
      .map(([providerId]) => providerId)
  } catch {
    return []
  }
}

function credentialsPath(store) {
  return path.join(store, 'workspaces', DEFAULT_SPACE_ID, 'credentials.json')
}

/** 迁移之后 default 空间凭证池的样子。没迁 / 没写 → undefined。 */
function credentialPoolOf(store) {
  try {
    return JSON.parse(readFileSync(credentialsPath(store), 'utf-8'))
  } catch {
    return undefined
  }
}

function discoveryOf(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}`)
}

function authHeaders(record) {
  return record.token ? { authorization: `Bearer ${record.token}` } : {}
}

async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(record) },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  return response.json()
}

async function providerCountOf(record) {
  const list = await rpc(record, 'providers', 'list')
  return (list?.data?.providers ?? list?.providers ?? []).length
}

async function capabilitiesOf(record) {
  const response = await fetch(`http://${record.host}:${record.port}/api/capabilities`, {
    headers: authHeaders(record),
  })
  if (!response.ok) throw new Error(`capabilities HTTP ${response.status}`)
  return response.json()
}

function describePool(pool) {
  if (!pool) return '(没有凭证池文件)'
  const providers = pool.encryption === 'safeStorage'
    ? '(密文,内容见 ② 的解密读数)'
    : Object.keys(pool.providers ?? {}).join(',') || '(空)'
  return `encryption=${pool.encryption} providers=${providers}`
}

/** 对照组:纯 node 子进程当 core。它拿不到 app 身份,迁移只能写明文。 */
async function runSpawnServerLane(source) {
  console.log('\n[对照组 spawn-server] 纯 node 子进程当 core(D0 那条路)')
  const store = await materializeStore(source)
  let server
  try {
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const errors = []
    server.stderr.on('data', chunk => errors.push(chunk.toString()))
    const record = await waitFor('对照组 core 写出发现文件', () => {
      const found = discoveryOf(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nserver stderr:\n${errors.join('')}`)
    })
    await waitFor('对照组端口可连', () => portConnects(record.host, record.port))

    const providerCount = await providerCountOf(record)
    const pool = credentialPoolOf(store)
    console.log(`  · providers.list = ${providerCount} 条`)
    console.log(`  · 凭证池 ${describePool(pool)}`)
    return { providerCount, poolEncryption: pool?.encryption ?? '(无)' }
  } finally {
    if (server) {
      server.kill('SIGTERM')
      await delay(800)
    }
    await rm(store, { recursive: true, force: true })
  }
}

/**
 * 实验组:本壳内嵌 core。装配它的进程就是拿着 Electron app 身份的那个。
 *
 * ② 的解密**在壳自己的主进程里做**(playwright 的 `app.evaluate` 就跑在那里):
 * 脚本自己是纯 node,没有 safeStorage,也不该有 —— 「这份密文这个身份读得回来」
 * 这句话只有那个身份自己能证。
 */
async function runShellLane(source, oauthCandidates) {
  console.log('\n[实验组 shell] 壳内嵌 core(A1 换心之后)')
  const store = await materializeStore(source)
  let app
  try {
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    await app.firstWindow()
    const record = await waitFor('壳内嵌的 core 写出发现文件', () => {
      const found = discoveryOf(store)
      return found && found.owner === 'shell' ? found : undefined
    })
    await waitFor('壳的 core 端口可连', () => portConnects(record.host, record.port))
    // 迁移是装配序列里的一步,而装配在开窗之前就跑完了;这里等的是那次写盘落地。
    const pool = await waitFor('default 空间凭证池写出来', () => credentialPoolOf(store))

    const providerCount = await providerCountOf(record)
    console.log(`  · providers.list = ${providerCount} 条`)
    console.log(`  · 凭证池 ${describePool(pool)}`)

    assert(providerCount > 0, `① provider 目录非空(${providerCount} 条)`)

    assert(
      pool.encryption === 'safeStorage',
      `② 凭证池按 safeStorage 加密落盘(对照组同一份源料写的是 'none' = 明文)`,
    )

    // 解密在壳的主进程里做 —— 见函数头。
    const decrypted = await app.evaluate(async ({ safeStorage }, blob) => {
      try {
        return { ok: true, plain: safeStorage.decryptString(Buffer.from(blob, 'base64')) }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    }, pool.data)
    assert(decrypted.ok, `② 壳自己的主进程解得开这份密文${decrypted.ok ? '' : `(${decrypted.error})`}`)

    const providers = JSON.parse(decrypted.plain).providers ?? {}
    console.log(`  · 密文里的 provider:${Object.keys(providers).join(', ') || '(空)'}`)
    if (oauthCandidates.length === 0) {
      skip('② 的 oauth 那一半:源 store 里没有任何 oauth 密文 —— 这台机器上无从取证')
    } else {
      const carried = oauthCandidates.filter(providerId =>
        (providers[providerId]?.entries ?? []).some(entry => entry?.oauthToken?.accessToken))
      assert(
        carried.length > 0,
        `② 用户的 oauth 凭证真的过来了(${carried.join(', ')} 带着 accessToken)`,
      )
    }

    const capabilities = await capabilitiesOf(record)
    assert(capabilities?.collabRooms === true, '③ capabilities.collabRooms === true')
    return { providerCount, poolEncryption: pool.encryption }
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(store, { recursive: true, force: true })
  }
}

async function main() {
  for (const [label, entry] of [['dist/server/main.js', serverEntry], ['dist-electron/main.cjs', mainEntry]]) {
    if (!existsSync(entry)) {
      console.error(`[gate:credentials] 找不到 ${label} —— 先跑 \`bun run server:build\` / \`npm run app:build\``)
      process.exit(1)
    }
  }

  const source = resolveSourceStore()
  console.log(`[gate:credentials] 取证源(只读):${source}`)
  const oauthCandidates = encryptedOAuthProviders(source)
  console.log(`[gate:credentials] 源里带 oauth 密文的 provider:${oauthCandidates.join(', ') || '(无)'}`)

  const control = await runSpawnServerLane(source)
  const shell = await runShellLane(source, oauthCandidates)

  console.log('\n[gate:credentials] 对照读数')
  console.log(`  providers.list   spawn-server=${control.providerCount}   shell=${shell.providerCount}`)
  console.log(`  凭证池加密       spawn-server=${control.poolEncryption}   shell=${shell.poolEncryption}`)
  console.log('  (目录条数两边相同属预期:provider 注册表与凭证加密是两件事,分野在第二行)')
  console.log('\n[gate:credentials] ok')
}

main().catch(error => {
  console.error('\n[gate:credentials] FAILED:', error?.stack || error)
  process.exit(1)
})
