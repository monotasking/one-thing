import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * 通知中心的**存档**。屏幕上弹不弹是另一件事(见 services/notify.ts 的命运表),
 * 这里只回答一句话:**说过的话都在这儿**。
 *
 * 所以 `push` 不认识 toast、不认识级别的时长、也不认识面板 —— 它只往环里放一条记录。
 * 「弹不弹」由 notify 决定,「怎么画」由 NotificationsPanel 决定,
 * 三者各自能单测,不必把整条链一起搭起来。
 *
 * ── 为什么去重在这一层 ────────────────────────────────────────────────────
 * 一个错误风暴(同一个渲染错每帧抛一次)既不该刷屏,也不该把 200 条环挤干净 ——
 * 两件坏事的产地是同一件事:同一句话被记了 N 遍。所以合并发生在**入库那一刻**,
 * 而不是在 toast 侧做个节流阀:节流阀只挡住屏幕,存档照样被冲掉。
 * 合并不是丢弃:`count` 记着它响过几次,时间戳跟到最新那次。
 *
 * 窗口由**调用方**给(`dedupeMs`),不是全局常量:崩溃要 60s 合并,而「已打开
 * 某文件」这种同名却确实发生了两次的事不该被吞掉。默认不去重 —— 静默合并是
 * 有代价的行为,得有人显式要它。
 */

export type NotifyLevel = 'success' | 'info' | 'warn' | 'error' | 'silent'

export interface NotifyRecord {
  id: string
  /** epoch 毫秒。合并时跟到**最新**那一次。 */
  time: number
  level: NotifyLevel
  /** 一句短话。它同时是去重的键的一半(另一半是 source)。 */
  title: string
  /** 一行补充。列表里截断成一行,不折行。 */
  body?: string
  /** ns 风格短串('crash.renderer' / 'perf.interaction')。谁说的。 */
  source: string
  /** 详情行的原样文本(mono 展示,可多行)。 */
  detail?: string
  read: boolean
  /** 被合并过几次(含首次)。1 = 没合并过 —— 只有 >1 才有话说。 */
  count: number
}

export interface NotifyDraft {
  level: NotifyLevel
  title: string
  body?: string
  source: string
  detail?: string
  /**
   * 去重窗口(毫秒)。给了就先找**同 source 同 title 且在窗口内**的那条合并进去;
   * 不给 = 每次都是新的一条。
   */
  dedupeMs?: number
}

export interface NotifyPushResult {
  id: string
  /** true = 合并进了已有的一条。产地据此决定「这次还要不要再弹一遍」。 */
  merged: boolean
}

/** 环形上限。200 条 ≈ 一整天的正常量,又不至于把内存和存档吃住。 */
export const NOTIFY_RING_CAPACITY = 200

/**
 * 落盘的只有最近 100 条(裁量记档,08-30):
 *  · 存档的用处是「刚才那条我没看清」,不是「翻三天前的账」—— 真要翻账该看
 *    app.jsonl,那才是日志的家(面板底部那道入口就是通往它的,今天还没接);
 *  · localStorage 是同步 API,写在主线程上。200 条带 detail(栈能有几 KB)一次
 *    序列化几百 KB,每来一条通知就写一遍,那是拿手感换一份本来就该在磁盘上的东西;
 *  · 满了 / 隐私模式下 setItem 会抛 —— 所以下面那层 storage 每个口都 try/catch:
 *    **存档失败不许连累通知本身**,通知在内存里照常成立。
 */
export const NOTIFY_PERSIST_LIMIT = 100

let seq = 0

function nextId(time: number): string {
  seq += 1
  return `${time}-${seq}`
}

/** 未读数。派生量,不存字段 —— 存了就有第二个真相要维护。 */
export function unreadOf(items: readonly NotifyRecord[]): number {
  let n = 0
  for (const item of items) if (!item.read) n += 1
  return n
}

/** 每个口都吞异常:存档是锦上添花,炸了也不许连累通知本身。 */
const safeStorage = createJSONStorage(() => ({
  getItem: (key: string) => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage?.setItem(key, value)
    } catch {
      // 配额满 / 隐私模式:这一条不落盘,内存里照样在。
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage?.removeItem(key)
    } catch {
      // 同上。
    }
  },
}))

interface NotifyCenter {
  /** 最新在前。面板按天分组时顺序天然就对。 */
  items: NotifyRecord[]
  /** `now` 只给测试用 —— 产品代码一律不传,时钟同源。 */
  push: (draft: NotifyDraft, now?: number) => NotifyPushResult
  markAllRead: () => void
  clear: () => void
  /**
   * 面板到场。语义上它就是「这些我看见了」,所以实现与 markAllRead 同一件事 ——
   * 名字不同是因为**调用点的理由**不同:一个是用户点了「全部已读」,一个是面板
   * 被打开了。留两个名字,是为了让将来给「打开即已读」加条件(比如只清可见的那些)
   * 时不必先去分辨这两类调用点。
   */
  act: () => void
}

export const useNotifyStore = create<NotifyCenter>()(
  persist(
    (set, get) => ({
      items: [],

      push: (draft, now = Date.now()) => {
        let result: NotifyPushResult = { id: '', merged: false }
        set((st) => {
          const window = draft.dedupeMs ?? 0
          if (window > 0) {
            const at = st.items.findIndex(
              (x) => x.source === draft.source && x.title === draft.title && now - x.time <= window,
            )
            if (at >= 0) {
              const prev = st.items[at]
              const merged: NotifyRecord = {
                ...prev,
                time: now,
                count: prev.count + 1,
                // 又响了一次 = 又要人看一眼,所以合并把它重新翻回未读。
                read: false,
                body: draft.body ?? prev.body,
                detail: draft.detail ?? prev.detail,
              }
              result = { id: prev.id, merged: true }
              // 合并后它是最新的一条,提到队首 —— 否则「最新在前」这条不变式就破了。
              return { items: [merged, ...st.items.filter((_, i) => i !== at)] }
            }
          }
          const record: NotifyRecord = {
            id: nextId(now),
            time: now,
            level: draft.level,
            title: draft.title,
            body: draft.body,
            source: draft.source,
            detail: draft.detail,
            read: false,
            count: 1,
          }
          result = { id: record.id, merged: false }
          return { items: [record, ...st.items].slice(0, NOTIFY_RING_CAPACITY) }
        })
        return result
      },

      // 全读过了就原样返回 st:zustand 对 Object.is 相同的下一态不通知订阅者,
      // 于是「面板可见时清未读」那个副作用不会把自己循环触发起来。
      markAllRead: () =>
        set((st) =>
          st.items.some((x) => !x.read)
            ? { items: st.items.map((x) => (x.read ? x : { ...x, read: true })) }
            : st,
        ),

      clear: () => set((st) => (st.items.length === 0 ? st : { items: [] })),

      act: () => get().markAllRead(),
    }),
    {
      name: 'onething.notifications',
      version: 1,
      storage: safeStorage,
      partialize: (st) => ({ items: st.items.slice(0, NOTIFY_PERSIST_LIMIT) }),
    },
  ),
)

/** 组件用的未读数。返回的是个数字,所以选择器每次重算也不会白白重渲染。 */
export function useUnreadCount(): number {
  return useNotifyStore((st) => unreadOf(st.items))
}
