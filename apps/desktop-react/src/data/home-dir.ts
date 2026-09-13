import { useSyncExternalStore } from 'react'

/**
 * **这台机器的家目录** —— 一格一次性的宿主事实(09-13)。
 *
 * 用处只有一个:把路径的家目录前缀画成 `~`(`ui/PathText`)。
 * `/Users/yitiansong` 这 17 个字在单用户的桌面上不带任何信息,却让九成路径
 * 在 320px 的提示体里多出一行。
 *
 * ── 为什么是问宿主要,不是渲染层自己拼 ──────────────────────────────────
 * `data/files-source.ts` 文件头那条判例写着「**不在渲染层自己拼 homedir**
 * —— 浏览器里根本没有那个事实,拼出来就是编」。这一格不是推翻它,是**兑现**
 * 它:事实由 core 经 `GET /api/capabilities` 给出(`homeDir`),而 core 那一侧
 * 与 `localFileSystem` 同判据 —— 不可信的客户端拿到的是 `null`,于是浏览器壳
 * 照旧一个字都不缩,判据一处都没重写。
 *
 * ── 为什么不是 `data/kernel` 的 query ───────────────────────────────────
 * kernel 的 `Query` 造的是「可以重问、会被标脏、要 keep-previous」的那一族。
 * 家目录在一个进程的一生里**不会变**:没有重拉、没有失效、没有换键,拿它当
 * query 是给一件常量配一台状态机。所以这里是最朴素的那一形 —— 模块级一发
 * promise + `useSyncExternalStore`,零新依赖。
 *
 * ── 拿到之前是 `null` ───────────────────────────────────────────────────
 * `null` 的意思就是「不缩」。**不闪**:先画全路径、拿到之后缩成 `~`,是一次
 * 变短;反过来(先猜 `~` 再摊开)才是假事实被戳破。失败同样落在 `null` 上 ——
 * 一句提示里少两个字不值得弹一条通知。
 */

export interface HomeDirPort {
  /** 拿不到 / 不该知道 → `null`。**不抛** —— 判词在文件头最后一段。 */
  get(): Promise<string | null>
}

let port: HomeDirPort | undefined

/**
 * 拆卸:忘掉答案、忘掉「问过了」,再把订阅者叫醒一次。
 * **这只函数是本模块唯一的一口拆卸** —— 换端口与 HMR 退役共用它,
 * 两套拆卸迟早漏一格(判词在壳 CLAUDE.md 的模块级副作用那条)。
 */
function resetHomeDir(): void {
  value = null
  started = false
  emit()
}

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureHomeDirPort(next: HomeDirPort | undefined): void {
  port = next
  resetHomeDir()
}

/**
 * 真实现**惰性**建 —— 与 `data/files-port.ts` 逐字同一条理由:它要的是那个
 * 连通之后才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<string | null> {
  const { onethingClient } = await import('../platform/connection')
  const client = await onethingClient()
  const caps = await client.capabilities()
  return caps.homeDir ?? null
}

let value: string | null = null
let started = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  const once = port ? port.get() : realPort()
  void once
    .then((next) => {
      if (next === value) return
      value = next
      emit()
    })
    // 拿不到就维持 `null` = 不缩。这条路上没有一句话是用户在等的。
    .catch(() => {})
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // 第一个订阅者到场才去问 —— 没人画路径的那些屏不该为此打一发请求。
  // 放在 subscribe 里而不是渲染体里:它由 React 在 effect 阶段调,是副作用该在的地方。
  start()
  return () => {
    listeners.delete(listener)
  }
}

// `useSyncExternalStore` 要求 getSnapshot 稳定:这里交出去的是一个模块级的
// `string | null`,没有每次现造的对象,所以它天生稳定。
const snapshot = (): string | null => value

/** 拿到之前是 `null` = 不缩(判词在文件头)。 */
export function useHomeDir(): string | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/*
 * 模块级副作用要配 HMR 退役(壳 CLAUDE.md 那条):这儿留着一格订阅者名册与
 * 一份问过的答案,它们的寿命就是**这个模块实例**。生产构建里
 * `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    listeners.clear()
    resetHomeDir()
  })
}
