import type { ToolStepView } from './tool-step-view'

export type StepActivityRunKind = 'edited' | 'utility' | 'misc'

export interface StepActivityRun {
  id: string
  kind: StepActivityRunKind
  views: ToolStepView[]
}

export function isEditedStepView(view: ToolStepView): boolean {
  return view.toolName === 'write' || view.toolName === 'edit' || !!view.diff || !!view.streamingContent
}

export function isExploreStepView(view: ToolStepView): boolean {
  return ['read', 'grep', 'glob'].includes(view.toolName)
}

export function getStepActivityRunKind(view: ToolStepView): StepActivityRunKind {
  if (isEditedStepView(view)) return 'edited'
  if (isExploreStepView(view) || view.toolName === 'bash') return 'utility'
  return 'misc'
}

export function canMergeStepActivityRun(kind: StepActivityRunKind): boolean {
  return kind === 'edited' || kind === 'utility'
}

export function shouldFlowStepActivityTitle(view: ToolStepView): boolean {
  return view.toolName === 'bash' && ['pending', 'streaming-input', 'received', 'executing'].includes(view.status)
}

export function buildStepActivityRuns(views: ToolStepView[]): StepActivityRun[] {
  const runs: StepActivityRun[] = []

  for (const view of views) {
    const kind = getStepActivityRunKind(view)
    const last = runs[runs.length - 1]
    if (last && last.kind === kind && canMergeStepActivityRun(kind)) {
      last.views.push(view)
    } else {
      runs.push({ id: `${kind}-${view.id}`, kind, views: [view] })
    }
  }

  return runs
}
