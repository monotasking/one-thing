import { TOAST_LIFE_MS } from '../components/motion'
import { pushToast, useToastHub } from '../ui/Toast'
import { NOTIFICATIONS_ITEM_ID } from '../stage/items'
import { useStageStore } from '../stage/store'
import { t } from '../i18n'
import { NOTIFY_RING_CAPACITY, useNotifyStore } from './notify-store'
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
 * ── 详情去哪儿看(09-01 崩溃弹框整改)──────────────────────────────────────
 * 一条通知带 `detail`(栈、完整 URL、原样报文)时,**弹框上不铺开它**:那一段
 * 是给排障的人看的,把它铺在屏幕右上角只会让一句人话变成一屏机器话。弹框上只留
 * 一道门,门后是**已经存在**的那块面 —— 通知中心里那条可展开的记录。
 *
 * 走的是点 Dock 图标那条唯一进出口(和折叠丸同一条路,见 AppShell 里的 onMore),
 * 不另开特权浮层:通知中心是一块普通的瓦。
 */
function openNotificationCenter(): void {
  useStageStore.getState().clickDockIcon(NOTIFICATIONS_ITEM_ID)
}

/**
 * 屏幕上那条 toast 的 id ↔ 存档里那条记录的 id。
 *
 * 只为一件事存在:同一条又响了一次时,把**已经在屏上的那条**改成「×N」。
 * 不能拿存档 id 当 toast id —— 两边的生命周期不同(toast 会到期、会被折走,
 * 记录不会),所以这里存的是一条**可能已经失效**的引用,hub 的 update 自己
 * 会挡住失效的那次(不在屏上就什么都不做)。
 */
const toastOfRecord = new Map<string, number>()

/**
 * 说一句话。返回存档里那条记录的 id。
 *
 * 被去重合并掉的那次**不再弹一遍**(那正是合并要挡住的事:一个错误风暴刷屏),
 * 但它照样记进存档 —— 合并是「同一条又响了一次」,不是「这次没发生」。
 * 屏上那条还在的话,把合并次数写到它身上:**一个框,一个越涨越大的计数**,
 * 而不是五个一模一样的框(HMR 里一个渲染错连炸五次就是这一形)。
 */
export function notify(draft: NotifyDraft): string {
  const { id, merged } = useNotifyStore.getState().push(draft)
  const fate = NOTIFY_FATE[draft.level]
  const count = useNotifyStore.getState().items.find((x) => x.id === id)?.count ?? 1
  if (fate.toast && merged) {
    const live = toastOfRecord.get(id)
    if (live !== undefined) useToastHub.getState().update(live, { note: t('notify.repeat', { count }) })
  }
  if (fate.toast && !merged) {
    const toastId = pushToast({
      // silent 已经被 fate.toast 挡在门外,所以这里剩下的四档正是 ToastLevel。
      level: draft.level as Exclude<NotifyLevel, 'silent'>,
      title: draft.title,
      body: draft.body,
      lifeMs: fate.lifeMs,
      // 有详情才画门。没详情的那些(「消息没发出去」之类)点过去也无话可说。
      action: draft.detail
        ? { label: t('notify.viewDetails'), onClick: openNotificationCenter }
        : undefined,
    })
    toastOfRecord.set(id, toastId)
    // 存档自己是个环,被挤出去的那些记录再也不会来合并了 —— 它们在这张表里的位置
    // 也就没有意义了。Map 按插入序遍历,所以「删最老的一条」就是一句 keys().next()。
    while (toastOfRecord.size > NOTIFY_RING_CAPACITY) {
      const oldest = toastOfRecord.keys().next().value
      if (oldest === undefined) break
      toastOfRecord.delete(oldest)
    }
  }
  return id
}
