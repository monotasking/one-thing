import { useMemo } from 'react'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import { relativeTime } from '../transitions'
import type { RelativeTimeLabel } from '../transitions'

/**
 * 相对时间的**成品句子**在这里拼,标识在 transitions.relativeTime 里算 ——
 * 这是「纯函数不产界面字符串」那条规矩在时间上的落地(同 timeBucket / TimeBucket)。
 *
 * 星期几是七个键而不是一个数组下标拼出来的键名:字典的键集要在类型层可枚举,
 * 拼出来的键 typecheck 管不到,漏一条只有换语言时才发现。
 */
const WEEKDAY_KEYS: MessageKey[] = [
  'time.weekday0',
  'time.weekday1',
  'time.weekday2',
  'time.weekday3',
  'time.weekday4',
  'time.weekday5',
  'time.weekday6',
]

export function formatRelativeTime(label: RelativeTimeLabel, t: TFn): string {
  switch (label.kind) {
    case 'clock':
      return t('time.clock', { hh: label.hh, mm: label.mm })
    case 'yesterday':
      return t('time.yesterday')
    case 'weekday':
      return t(WEEKDAY_KEYS[label.weekday] ?? 'time.weekday0')
    case 'date':
      return t('time.date', { month: label.month, day: label.day })
  }
}

/**
 * 组件用:给一个时间戳,回一句话。`now` 在 hook 里取一次而不是每格取一次 ——
 * 同一屏里两张卡不该因为渲染差了几毫秒而落进不同的日子。
 */
export function useSessionTime(): (updatedAt: number) => string {
  const t = useT()
  return useMemo(() => {
    const now = Date.now()
    return (updatedAt: number) => formatRelativeTime(relativeTime(updatedAt, now), t)
  }, [t])
}
