import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PLAN_JUST_DONE_MS } from '../../components/motion'
import type { ComposerStrip, StripBarModel } from '../../composer/strip'
import { useQuery } from '../../data/kernel'
import { todoDocumentFamily, todoSessionRef, useTodoLive } from '../../data/todo-source'
import { useT } from '../../i18n'
import { Button } from '../../ui/Button'
import { openFileInCurrentTarget } from '../viewer/open-target'
import { parseUnits } from '../editing/units'
import { newlyDone, summarizePlan } from './plan-model'
import { TodoDocView } from './TodoDocView'
import { todoScrollPorts, useTodoEditorDocument } from './todo-document'
import { useScrollMemory } from '../../ui/scroll-memory'
import s from './PlanStrip.module.css'

/**
 * 计划条:这个会话的 AI 计划(`todo:session/<id>`)在输入框顶上的一行,点开是可编辑的抽屉
 * (正本 `docs/todo-2026-09.md` §5.3)。
 *
 * | 情况 | 条上 |
 * | --- | --- |
 * | 没有计划 / 一项任务都没有 / 读失败 / 首次读取中 | 不出现(不画骨架) |
 * | 进行中 | 进度槽 +「计划 9/12」+ 淡色「下一步 …」 |
 * | 刚勾掉一项 | 强调色「刚完成 …」,`PLAN_JUST_DONE_MS` 后退回「下一步」 |
 * | 全部完成 | 完成点 + 灰字「计划完成 12/12」 |
 *
 * 数据按 `sessionId` 分家:每个会话一格查询,切会话不串。
 */
function usePlanBar(sessionId: string): StripBarModel | null {
  const t = useT()
  useTodoLive()
  const query = todoDocumentFamily.get(todoSessionRef(sessionId))
  const snapshot = useQuery(query)
  useEffect(() => { void query.ensure() }, [query])

  const view = snapshot.data
  const summary = useMemo(() => (view?.exists ? summarizePlan(view.content) : null), [view])
  const justDone = useJustDone(sessionId, summary?.doneTexts ?? null)

  return useMemo(() => {
    if (!summary || summary.total === 0) return null
    const counts = { done: summary.done, total: summary.total }
    if (summary.next === null) {
      return { indicator: { kind: 'done' }, text: t('todo.plan.allDone', counts), tone: 'muted', label: t('todo.plan.toggle') }
    }
    const progress = { kind: 'progress', value: summary.done / summary.total } as const
    if (justDone) {
      return { indicator: progress, text: t('todo.plan.justDone', { text: justDone }), tone: 'accent', label: t('todo.plan.toggle') }
    }
    return {
      indicator: progress,
      text: t('todo.plan.progress', counts),
      detail: t('todo.plan.next', { text: summary.next }),
      label: t('todo.plan.toggle'),
    }
  }, [summary, justDone, t])
}

/**
 * 认出「刚完成」的那一项,停留一个读认窗口。换会话从头认(第一次读数不算刚发生)。
 *
 * 认的那一步**在渲染里做**(React「渲染期间按上一次的值调整状态」的写法),不在 effect 里:
 * 放在 effect 里会先提交一帧「计划 4/5 · 下一步」,下一帧才换成「刚完成」—— 真机上量到过
 * 这一帧闪。计时器只负责退场。
 */
function useJustDone(sessionId: string, doneTexts: readonly string[] | null): string | null {
  const [track, setTrack] = useState<{ sessionId: string; texts: readonly string[] | null; text: string | null; stamp: number }>(
    { sessionId, texts: doneTexts, text: null, stamp: 0 },
  )
  const sameSession = track.sessionId === sessionId
  if (!sameSession || (doneTexts !== null && track.texts !== doneTexts)) {
    const text = doneTexts === null ? null : newlyDone(sameSession ? track.texts : null, doneTexts)
    setTrack({
      sessionId,
      texts: doneTexts,
      text: text ?? (sameSession ? track.text : null),
      stamp: text === null ? track.stamp : track.stamp + 1,
    })
  }

  useEffect(() => {
    if (track.stamp === 0) return undefined
    const timer = setTimeout(() => setTrack(now => (now.stamp === track.stamp ? { ...now, text: null } : now)), PLAN_JUST_DONE_MS)
    return () => clearTimeout(timer)
  }, [track.stamp])

  return sameSession ? track.text : null
}

function PlanDrawer({ sessionId }: { sessionId: string }) {
  const { view, document } = useTodoEditorDocument(todoSessionRef(sessionId))
  if (!document) return null
  return <PlanDrawerBody sessionId={sessionId} filePath={view?.filePath} document={document} />
}

function PlanDrawerBody({ sessionId, filePath, document }: {
  sessionId: string
  filePath: string | undefined
  document: NonNullable<ReturnType<typeof useTodoEditorDocument>['document']>
}) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const ref = todoSessionRef(sessionId)
  // 这份计划之前滚过没有 —— 在滚动记忆还原之前取(第一次渲染时读,之后那只还原会写进去)。
  const remembered = useRef(todoScrollPorts.read(ref) !== undefined)
  const { onScroll } = useScrollMemory(scrollRef, ref, todoScrollPorts)
  /*
   * 第一次打开这份计划:落到第一条没做完的那一项,上面留一行看得见来处(B 形 §2.3)。
   * 滚过就听滚动记忆的 —— 人自己滚到哪儿比「第一条未完成」更说明他在看什么。
   */
  useLayoutEffect(() => {
    if (remembered.current) return
    remembered.current = true
    const scroller = scrollRef.current
    const first = parseUnits(document.lines).find(unit => unit.type === 'task' && !unit.done)
    const row = first && scroller?.querySelector<HTMLElement>(`[data-unit="${first.start}"]`)
    if (!scroller || !row) return
    const rowBox = row.getBoundingClientRect()
    scroller.scrollTop += rowBox.top - scroller.getBoundingClientRect().top - rowBox.height
  }, [document])
  return (
    <div className={s.drawer} aria-label={t('todo.plan.drawerLabel')} role="region">
      <div ref={scrollRef} className={s.doc} onScroll={onScroll}>
        <TodoDocView document={document} density="drawer" owner={`plan:${sessionId}`} />
      </div>
      {filePath && (
        <div className={s.footer}>
          <Button size="sm" onClick={() => openFileInCurrentTarget(filePath)}>
            {t('todo.openSource')}
          </Button>
        </div>
      )}
    </div>
  )
}

export const planStrip: ComposerStrip = {
  id: 'plan',
  order: 10,
  useBar: usePlanBar,
  Drawer: PlanDrawer,
}
