/**
 * `practice` 工具的适配器工厂(D191,从 `toolkit/toolkit-adapters.ts` 搬回 practice)。
 *
 * 它绑的是 practice 的服务槽,所以住在 practice、经 practice 入口交出;`backend.ts` 在造工具目录的那一行调它。
 * 服务在**调这只工厂的那一刻**取一次(与从前在目录里取的时刻相同),关掉之后再调工具报 `PracticeServiceClosedError`。
 * 本文件只引兄弟文件,不引 practice 入口;对 toolkit 只有类型引用。
 */
import type { PracticeToolAdapters } from '@onething/backend/toolkit'
import { PracticeServiceClosedError } from './practice-service.js'
import { getPracticeServiceSafe } from './practice-service-slot.js'

export function practiceToolAdapters(): PracticeToolAdapters {
  const captured = getPracticeServiceSafe()
  const service = () => {
    if (!captured) throw new PracticeServiceClosedError()
    return captured
  }
  return {
    log: input => service().logPractice({
      name: input.name,
      source: 'agent',
      note: input.note,
      exercise: input.exercise ?? {},
      ts: input.ts,
    }),
    query: request => service().getPracticeSummary(request),
    recent: (days, limit) => service().getRecentPracticeRecords(days, limit),
  }
}
