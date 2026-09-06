import { useT } from '../../../i18n'
import { useSessionTime } from '../../../expose/components/session-time'
import type { SearchPreviewProps, SearchPreviewRenderer } from '../registry'
import s from '../Preview.module.css'

/**
 * `kind: 'session-overview'` —— 一间会话的四格
 * (`runtime/src/search/capabilities/preview.ts` 的 `SessionOverviewPreview`)。
 *
 * 它是**随候选带**的那一种(chats 的自述是 `preview: { mode: 'inline' }`),
 * 所以选中一条会话命中时预览窗**当场就有内容**,一发请求都不出门。
 *
 * 时间那一格走壳既有的 `useSessionTime`(相对时间要查字典),不在这里再拼一遍 ——
 * 与结果行的出处用的是同一只 hook,两处不可能说出不同的「3 天前」。
 */

interface SessionOverviewPayload {
  sessionId: string
  title: string
  messageCount: number
  updatedAt: number
  preview: string
}

/** 验而不信(同 message-context)。 */
export function sessionOverviewPayloadOf(payload: unknown): SessionOverviewPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = payload as Partial<SessionOverviewPayload>
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) return undefined
  return {
    sessionId: raw.sessionId,
    title: typeof raw.title === 'string' ? raw.title : '',
    messageCount: typeof raw.messageCount === 'number' ? raw.messageCount : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    preview: typeof raw.preview === 'string' ? raw.preview : '',
  }
}

function SessionOverviewBody({ payload }: SearchPreviewProps) {
  const t = useT()
  const timeOf = useSessionTime()
  const overview = sessionOverviewPayloadOf(payload)
  if (overview === undefined) return <p className={s.meta}>{t('search.previewMalformed')}</p>
  return (
    <div className={s.body}>
      {/*
        * **标题不在这里画**(R6:预览檐标题只出现一次)。檐已经画过 `payload.title`
        * 了 —— 从前这里再画一遍,于是屏幕上同一句话上下叠两行。判据钉在
        * `__tests__/preview.test.tsx`(「Body 不含 title」)。
        */}
      <dl className={s.facts}>
        <dt className={s.factKey}>{t('search.previewMessageCount')}</dt>
        {/* 条数是**文字读数**不是计数徽(计数禁令的另一半:读数可以)。 */}
        <dd className={s.factValue} data-fact="count">{overview.messageCount}</dd>
        <dt className={s.factKey}>{t('search.previewUpdatedAt')}</dt>
        <dd className={s.factValue} data-fact="updated">
          {/* `0` = 后端没给。画一个 1970 年比留白更糟,所以如实说「不知道」。 */}
          {overview.updatedAt > 0 ? timeOf(overview.updatedAt) : t('search.previewUnknownTime')}
        </dd>
      </dl>
      {overview.preview.length > 0 && <p className={s.text}>{overview.preview}</p>}
    </div>
  )
}

export const sessionOverviewPreviewRenderer: SearchPreviewRenderer = {
  kind: 'session-overview',
  Body: SessionOverviewBody,
}
