import { useEffect, useSyncExternalStore } from 'react'
import type { ResourceReadView } from '@shared/ipc/resources'
import type { PetUtterance } from '../pets/types'
import { createQuery } from './kernel'
import { ResourcePortSlot, type ResourceEventFact, type ResourcePort } from './resource-port'

/**
 * 宠物的数据层(宠物 P2 · 壳半边,正本 `docs/design/pet-system-2026-09.md` §9.1 / §9.5)。
 *
 * 读 `pet:current`、订 `resource:event` 里前缀 `pet:` 的事实、把戳 / 撸转成 `pet:` 的做法。
 * 与 `music-source.ts` 同形:端口是 `resources` 域那三口(`resource-port.ts`),这里一个
 * 字的分支都不认识宠物之外的东西。
 *
 * ── 为什么「最新一句话」不从读数里取 ──────────────────────────────────────
 * `current` 交的是最近 20 条,**包括很久以前说的**。栖位要的是「此刻刚说的那一句」:
 * 面板一打开就把一小时前那句重播一遍是错的。所以「最新一句」只由 `utterance` 事件
 * 产生(`latest` 那一格),读数只负责对账那 20 条。每条事件造一个新对象 ——
 * `PetStage` 按引用认人,新对象身份 = 新话语。
 *
 * `receivedAt` 是**壳这边的钟**:宿主拿它和本地那一路开口(P1 的 `startingSay`)比谁更新,
 * 两个时间都出自同一台机器的同一个钟,浏览器壳连远端 server 时也不怕两台机器的钟差。
 *
 * ── 宿主没有宠物子系统时 ─────────────────────────────────────────────────
 * `pet:` 没登记(CLI 守护进程那种宿主)= `current` 读失败,`latest` 永远是 `null`,手势发出去
 * 的做法失败被吞掉。栖位照 P1 行为跑,**零提示**(§9.5 最后一条)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:① 生命周期(这条线不是组件,②③ 在消费它的栖位组件头上)
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  · 挂载    —— import 只建一格空 query、一格空 `latest`,零往返、零订阅;
 *  · 首载    —— `openPetSource()`:等传输面 ready → 订 `pet:` 前缀 → `current` ensure 一次。
 *               先订后拉,拉的那一刻说的话不漏;
 *  · 事件到达 —— `utterance`:造一份新的 `latest`、`current` 标脏(后台对账不清屏);
 *               其余(`poked` / `stroked`)不改屏上任何东西,当没看见;
 *  · 读失败  —— query 留着 error,没人读它的 error:栖位零提示;
 *  · 卸载    —— refcount 归零才退订,`latest` 留着(重新挂载的栖位不会重播它:舞台只播
 *               挂载**之后**换过的引用);
 *  · HMR     —— `resetPetSource()`,复用同一口拆卸。
 */

export const PET_SCHEME_PREFIX = 'pet:'
export const PET_CURRENT_REF = 'pet:current'

/** 一句话语(后端 `Utterance` 的形,§2.3)。 */
export interface PetUtteranceView {
  id: string
  petId: string
  mode: 'speak' | 'mutter'
  text: string
  about?: { scheme: string; event: string }
  at: number
  duck: boolean
}

/** `pet:current` 读法的形(§9.3)。 */
export interface PetCurrentView {
  pet: { id: string; name: string; rig: string }
  speaking: boolean
  speakingUntil?: number
  utterances: PetUtteranceView[]
}

/** 一句刚到的话:给舞台的那个对象,和它在壳这边到达的时刻。 */
export interface PetUtteranceArrival {
  utterance: PetUtterance
  receivedAt: number
}

/* ── 端口 ─────────────────────────────────────────────────────────────────── */

const slot = new ResourcePortSlot()

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configurePetPort(next: ResourcePort | undefined): void {
  slot.configure(next)
}

function readFailureText(view: ResourceReadView): string {
  switch (view.kind) {
    case 'invalid':
      return view.message
    case 'denied':
      return view.reason
    case 'failed':
      return view.error.message
    default:
      return ''
  }
}

/* ── 读数 ─────────────────────────────────────────────────────────────────── */

export const petCurrentQuery = createQuery<PetCurrentView>('pet.current', async () => {
  const port = await slot.get()
  await port.ready()
  const answer = await port.read(PET_CURRENT_REF, 'current')
  if (answer.kind === 'ok') return answer.value as PetCurrentView
  throw new Error(readFailureText(answer))
})

/**
 * 当前宠物的 id。读不到是 `undefined`。
 *
 * 只订这一格而不是整份快照:读数的 `phase` / `inflight` / `error` 变化(包括宿主没有宠物时
 * 那一次失败)不该让栖位重渲 —— 它只关心「是哪一只」。
 */
export function useCurrentPetId(): string | undefined {
  return useSyncExternalStore(petCurrentQuery.subscribe, currentPetId, currentPetId)
}

function currentPetId(): string | undefined {
  return petCurrentQuery.get().data?.pet.id
}

/* ── 最新一句 ─────────────────────────────────────────────────────────────── */

let latest: PetUtteranceArrival | null = null
const latestListeners = new Set<() => void>()

function subscribeLatest(listener: () => void): () => void {
  latestListeners.add(listener)
  return () => {
    latestListeners.delete(listener)
  }
}

function getLatest(): PetUtteranceArrival | null {
  return latest
}

function setLatest(next: PetUtteranceArrival | null): void {
  latest = next
  for (const listener of [...latestListeners]) listener()
}

function asUtterance(payload: unknown): PetUtteranceView | null {
  if (!payload || typeof payload !== 'object') return null
  const row = payload as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.text !== 'string') return null
  if (row.mode !== 'speak' && row.mode !== 'mutter') return null
  return row as unknown as PetUtteranceView
}

function onPetFact(fact: ResourceEventFact): void {
  if (fact.event !== 'utterance') return
  const view = asUtterance(fact.payload)
  if (!view) return
  setLatest({ utterance: { mode: view.mode, text: view.text }, receivedAt: Date.now() })
  petCurrentQuery.invalidate()
}

/**
 * 最新一句后端话语。**只由 `utterance` 事件产生**(见文件头),没来过就是 `null`。
 * 每条事件一个新对象。
 */
export function usePetUtterance(): PetUtteranceArrival | null {
  return useSyncExternalStore(subscribeLatest, getLatest, getLatest)
}

/* ── 手势 ─────────────────────────────────────────────────────────────────── */

/**
 * 戳 / 撸发给 `pet:`。**发完不等、失败不提示、不重试**(§9.5):手势在屏上的反应是本地的,
 * 不该因为后端掉线而有任何可见变化。
 */
function fire(op: 'poke' | 'stroke'): void {
  void (async () => {
    const port = await slot.get()
    await port.do(PET_CURRENT_REF, op)
  })().catch(() => undefined)
}

export const petOps = {
  poke: (): void => fire('poke'),
  stroke: (): void => fire('stroke'),
} as const

/* ── 这条线的开与关 ──────────────────────────────────────────────────────── */

let openCount = 0
let unsubscribe: (() => void) | undefined

export async function openPetSource(): Promise<void> {
  openCount += 1
  if (openCount > 1) return
  try {
    const port = await slot.get()
    await port.ready()
    if (openCount === 0) return
    unsubscribe?.()
    unsubscribe = port.onResourceEvent(PET_SCHEME_PREFIX, onPetFact)
    await petCurrentQuery.ensure()
  } catch {
    // 连不上 / 没有 `pet:`:栖位照 P1 跑,零提示。
  }
}

export function closePetSource(): void {
  if (openCount > 0) openCount -= 1
  if (openCount > 0) return
  unsubscribe?.()
  unsubscribe = undefined
}

/** 回到出厂:退订 + 读数归零 + 最新一句清空。测试与 HMR 用。 */
export function resetPetSource(): void {
  openCount = 0
  unsubscribe?.()
  unsubscribe = undefined
  petCurrentQuery.reset()
  setLatest(null)
}

/** 栖位挂着的那一段就是这条线活着的那一段。唯一的挂载点。 */
export function usePetLive(): void {
  useEffect(() => {
    void openPetSource()
    return () => closePetSource()
  }, [])
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法):那条订阅、`openCount`、`latest` 与它的
 * 监听表。退役复用 `resetPetSource`。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetPetSource)
}
