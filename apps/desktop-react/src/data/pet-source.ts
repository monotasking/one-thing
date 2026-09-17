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
 * `receivedAt` 是**壳这边的钟**(P2 时宿主拿它和本地那一路开口比谁更新;P3 删了本地那一路,
 * 它留着给排障与测试读)。
 *
 * ── ON AIR 与「声音说完了」(P3,§10.4 / §10.5)────────────────────────────
 * `hushed` 事件说「这一句真的说完了」。两格从它折出来,都不存进读数:
 *   · `onAirId`   —— 最近一句**开口**的 id,到它的 `hushed` 为止。嘀咕不点灯、也不灭灯;
 *   · `hushedId`  —— 最近一次说完的那一句的 id。栖位拿「最新一句 === 它」判气泡该不该收。
 * `hushed` 丢了(断线重连那一截)灯不能一直亮着:`current` 读数回来时若**已经包含**那句
 * 开口却答 `speaking: false`,那一句必然已经说完 —— 灯灭(读数早于那句开口就不作数)。
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
 *  · 事件到达 —— `utterance`:造一份新的 `latest`(开口还点灯)、`current` 标脏(后台对账不清屏);
 *               `hushed`:记下说完的那一句、对得上就灭灯;
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
  /** 后端话语的 id(`hushed` 按它对上)。 */
  id: string
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

/* ── 最新一句、灯、说完 ─────────────────────────────────────────────────── */

interface PetSpeechState {
  latest: PetUtteranceArrival | null
  onAirId: string | null
  hushedId: string | null
}

const EMPTY_SPEECH: PetSpeechState = { latest: null, onAirId: null, hushedId: null }
let speech: PetSpeechState = EMPTY_SPEECH
const speechListeners = new Set<() => void>()

function subscribeSpeech(listener: () => void): () => void {
  speechListeners.add(listener)
  return () => {
    speechListeners.delete(listener)
  }
}

function setSpeech(next: Partial<PetSpeechState>): void {
  speech = { ...speech, ...next }
  for (const listener of [...speechListeners]) listener()
}

const getLatest = (): PetUtteranceArrival | null => speech.latest
const getOnAir = (): boolean => speech.onAirId !== null
const getHushedId = (): string | null => speech.hushedId

function asUtterance(payload: unknown): PetUtteranceView | null {
  if (!payload || typeof payload !== 'object') return null
  const row = payload as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.text !== 'string') return null
  if (row.mode !== 'speak' && row.mode !== 'mutter') return null
  return row as unknown as PetUtteranceView
}

function onPetFact(fact: ResourceEventFact): void {
  if (fact.event === 'utterance') {
    const view = asUtterance(fact.payload)
    if (!view) return
    setSpeech({
      latest: { id: view.id, utterance: { mode: view.mode, text: view.text }, receivedAt: Date.now() },
      ...(view.mode === 'speak' ? { onAirId: view.id } : {}),
    })
    petCurrentQuery.invalidate()
    return
  }
  if (fact.event === 'hushed') {
    const payload = fact.payload as { utteranceId?: unknown } | null
    const id = typeof payload?.utteranceId === 'string' ? payload.utteranceId : null
    if (!id) return
    setSpeech({ hushedId: id, ...(speech.onAirId === id ? { onAirId: null } : {}) })
  }
}

/** 读数回来:包含那句开口却已经不在说 → 那句的 `hushed` 丢了,灯灭(见文件头)。 */
function reconcileOnAir(): void {
  const onAirId = speech.onAirId
  const data = petCurrentQuery.get().data
  if (!onAirId || !data || data.speaking) return
  if (data.utterances.some((utterance) => utterance.id === onAirId)) setSpeech({ onAirId: null })
}

/**
 * 最新一句后端话语。**只由 `utterance` 事件产生**(见文件头),没来过就是 `null`。
 * 每条事件一个新对象。
 */
export function usePetUtterance(): PetUtteranceArrival | null {
  return useSyncExternalStore(subscribeSpeech, getLatest, getLatest)
}

/** ON AIR:最近一句开口还没 `hushed`。 */
export function usePetOnAir(): boolean {
  return useSyncExternalStore(subscribeSpeech, getOnAir, getOnAir)
}

/** 最近一次说完的那一句的 id;没有过是 `null`。 */
export function usePetHushedId(): string | null {
  return useSyncExternalStore(subscribeSpeech, getHushedId, getHushedId)
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
let unsubscribeReconcile: (() => void) | undefined

export async function openPetSource(): Promise<void> {
  openCount += 1
  if (openCount > 1) return
  try {
    const port = await slot.get()
    await port.ready()
    if (openCount === 0) return
    unsubscribe?.()
    unsubscribe = port.onResourceEvent(PET_SCHEME_PREFIX, onPetFact)
    unsubscribeReconcile?.()
    unsubscribeReconcile = petCurrentQuery.subscribe(reconcileOnAir)
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
  unsubscribeReconcile?.()
  unsubscribeReconcile = undefined
}

/** 回到出厂:退订 + 读数归零 + 最新一句清空。测试与 HMR 用。 */
export function resetPetSource(): void {
  openCount = 0
  unsubscribe?.()
  unsubscribe = undefined
  unsubscribeReconcile?.()
  unsubscribeReconcile = undefined
  petCurrentQuery.reset()
  speech = EMPTY_SPEECH
  for (const listener of [...speechListeners]) listener()
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
