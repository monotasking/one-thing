import type { MessageKey } from '../i18n'

/**
 * **分节自述表**(方向 A §1.2 的 `SECTION_BUCKETS`)。
 *
 * 列表**只分一次组**,轴是时间(09-03 裁决 1)。这张表是那条轴的全部:
 * 有序,顺序即阅读顺序,最后一格是**月桶的兜底生成器**(逐月,最近的月在前)。
 * 「换分节轴:按 agent」= 换一张表,`flatten` 一个字不动(设计 §6 演练第三条)。
 *
 * 置顶不在这张表里,它在**表之前**:`isPinned` 先于时间落桶(裁决 4 ——
 * 「只在这一节出现不重复」),所以它是 `bucketize` 的第一道判据而不是一格 test。
 */

/**
 * 节标题的**标识**,不是成品文案 —— 纯函数不许产出界面字符串
 * (与 `relativeTime` / `RelativeTimeLabel` 逐字同一条判例,成品句子在渲染层拼)。
 *
 *  · `key`      —— 一句现成的话(置顶 / 今天 / 昨天 / 本周,以及**本年**的月份:
 *                  九月的标题就是 `time.month9` 自己,不需要再包一层);
 *  · `monthYear`—— 跨年的月份,渲染层拼 `expose.sectionMonthYear`
 *                  (zh「{year} 年 {month}」/ en「{month} {year}」,{month} 填的是
 *                  `time.month<N>` 那句话)。
 */
export type SectionLabel =
  | { kind: 'key'; key: MessageKey }
  | { kind: 'monthYear'; year: number; month: number }

/** 十二个月的名字。zh 是「9 月」,en 是「September」—— 一门语言一种体例。 */
export const MONTH_KEYS: readonly MessageKey[] = [
  'time.month1',
  'time.month2',
  'time.month3',
  'time.month4',
  'time.month5',
  'time.month6',
  'time.month7',
  'time.month8',
  'time.month9',
  'time.month10',
  'time.month11',
  'time.month12',
]

export interface SectionBucket {
  id: string
  label: SectionLabel
  /** 这个时间戳落不落这一格。按表序**首个为真**者胜,所以判据可以从窄到宽写。 */
  test: (updatedAt: number, now: number) => boolean
}

/** 置顶那一节的 id。它不由 `test` 判(判据是 `isPinned`),所以单列一格常量。 */
export const PINNED_SECTION_ID = 'pinned'

export const PINNED_SECTION: SectionBucket = {
  id: PINNED_SECTION_ID,
  label: { kind: 'key', key: 'expose.sectionPinned' },
  // 永不由时间落进来 —— 置顶是 bucketize 在查表**之前**判的那一道。
  test: () => false,
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 差几个**自然日**(不是差几个 24 小时)。凌晨一点看「昨天 23:50」那条,
 * 差 70 分钟却该读作昨天 —— 与 `relativeTime` 用的是同一只算法,故意重合。
 */
export function dayDistance(updatedAt: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY_MS)
}

/**
 * 时间轴上的固定三格。月桶不在表里:它是**一族**,由下面的生成器现造
 * (一年十二格写死在表里,等于把「今年」这个事实焊进代码)。
 */
export const SECTION_BUCKETS: readonly SectionBucket[] = [
  {
    id: 'today',
    label: { kind: 'key', key: 'expose.sectionToday' },
    test: (at, now) => dayDistance(at, now) <= 0,
  },
  {
    id: 'yesterday',
    label: { kind: 'key', key: 'expose.sectionYesterday' },
    test: (at, now) => dayDistance(at, now) === 1,
  },
  {
    id: 'thisWeek',
    label: { kind: 'key', key: 'expose.sectionThisWeek' },
    test: (at, now) => dayDistance(at, now) < 7,
  },
]

/** 月桶的 id:`month:2026-08`。**按本地时区**切分 —— 屏幕上那个「8 月」是本地的。 */
export function monthSectionId(updatedAt: number): string {
  const at = new Date(updatedAt)
  return `month:${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
}

/** 月桶的**兜底生成器**(表的最后一格)。本年只写月份,跨年才带上年。 */
export function monthSection(updatedAt: number, now: number): SectionBucket {
  const at = new Date(updatedAt)
  const year = at.getFullYear()
  const month = at.getMonth() + 1
  const label: SectionLabel =
    year === new Date(now).getFullYear()
      ? { kind: 'key', key: MONTH_KEYS[month - 1] }
      : { kind: 'monthYear', year, month }
  return { id: monthSectionId(updatedAt), label, test: (ts) => monthSectionId(ts) === monthSectionId(updatedAt) }
}

/**
 * 一个时间戳落哪一格。**查表,首个为真者胜**;一格都不中就交给月桶生成器。
 * 置顶不经这里(见 `PINNED_SECTION` 上那句)。
 */
export function sectionOf(updatedAt: number, now: number): SectionBucket {
  for (const bucket of SECTION_BUCKETS) {
    if (bucket.test(updatedAt, now)) return bucket
  }
  return monthSection(updatedAt, now)
}
