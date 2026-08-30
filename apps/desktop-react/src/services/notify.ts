import { TOAST_LIFE_MS } from '../components/motion'
import { pushToast } from '../ui/Toast'
import { useNotifyStore } from './notify-store'
import type { NotifyDraft, NotifyLevel } from './notify-store'

/**
 * **通知的唯一入口。** 一条入口、三种命运、一个家。
 *
 * 在这之前壳里想说句话有两条路:`useToast()` 弹一下(说完就没了),或者
 * `getLogger(ns).warn()` 进日志环(用户永远看不到)。于是「用户该知道的事」和
 * 「排障要看的事」被两套设施各切走一半,谁也不完整。这个文件把那道岔口合上:
 * **任何产地只准调 notify**,弹不弹由级别决定,而**无论弹不弹都进存档**。
 *
 * ── 命运表 ────────────────────────────────────────────────────────────────
 *   success  弹 3s 自动消失      info  弹 4s 自动消失
 *   warn     弹 8s 自动消失      error 弹,且**不自动消失**(点 ✕ 才走)
 *   silent   不弹
 * 五档都进中心存档 —— silent 不是「丢掉」,是「不打扰,但记下」(性能超预算就走它)。
 *
 * 这张表是**唯一**的判定处:toast 组件不认识级别的时长(它只收一个 lifeMs),
 * 中心不认识 toast。改一档时长只动这里一处。
 *
 * ── 它不写日志环 ──────────────────────────────────────────────────────────
 * 崩溃捕获 / 性能探针本来就往 `services/log.ts` 的环里写(那是排障现场,带 args
 * 与前后 200 条上下文)。notify 再写一遍就是同一句话记两遍,dump 出来的现场里
 * 每条错都成双 —— 所以这里一行日志都不写,两套设施各记各的那一面。
 */

export type { NotifyDraft, NotifyLevel, NotifyRecord } from './notify-store'

export interface NotifyFate {
  /** 弹不弹。 */
  toast: boolean
  /** 弹多久;null = 不自动消失。toast 不弹时无意义。 */
  lifeMs: number | null
}

export const NOTIFY_FATE: Record<NotifyLevel, NotifyFate> = {
  success: { toast: true, lifeMs: TOAST_LIFE_MS.success },
  info: { toast: true, lifeMs: TOAST_LIFE_MS.info },
  warn: { toast: true, lifeMs: TOAST_LIFE_MS.warn },
  // 出错要人**做点什么**,而不是等它自己飘走。所以它没有寿命,只有 ✕。
  error: { toast: true, lifeMs: null },
  // 不打扰,但记下。lifeMs 在这一档没有意义(没人会问一个不弹的东西活多久)。
  silent: { toast: false, lifeMs: null },
}

/**
 * 说一句话。返回存档里那条记录的 id。
 *
 * 被去重合并掉的那次**不再弹一遍**(那正是合并要挡住的事:一个错误风暴刷屏),
 * 但它照样记进存档 —— 合并是「同一条又响了一次」,不是「这次没发生」。
 */
export function notify(draft: NotifyDraft): string {
  const { id, merged } = useNotifyStore.getState().push(draft)
  const fate = NOTIFY_FATE[draft.level]
  if (fate.toast && !merged) {
    pushToast({
      // silent 已经被 fate.toast 挡在门外,所以这里剩下的四档正是 ToastLevel。
      level: draft.level as Exclude<NotifyLevel, 'silent'>,
      title: draft.title,
      body: draft.body,
      lifeMs: fate.lifeMs,
    })
  }
  return id
}
