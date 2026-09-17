import { isList, parseUnits } from '../editing/units'

/**
 * 计划条的读法(纯函数;正本 `docs/todo-2026-09.md` §5.3)。
 *
 * 条上只要四样:共几项、完成几项、下一步是哪一项、哪些项已完成(用来认出「刚完成」)。
 * 用的是编辑器同一份行单元解析,所以条与抽屉对「哪一行是任务」永远是同一个回答。
 */
export interface PlanSummary {
  readonly total: number
  readonly done: number
  /** 第一条未完成的任务(纯文字);全部完成时为 null。 */
  readonly next: string | null
  /** 已完成任务的纯文字,按原顺序,可重复。 */
  readonly doneTexts: readonly string[]
}

/** 条上不画记号:去掉行内 markdown 的标记,只留读得出来的字。 */
export function plainTaskText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|~~)(.+?)\1/g, '$2')
    .replace(/\*(.+?)\*/g, '$1')
    // 下划线只在词边界上才是强调(`elcc_real_product` 里的下划线是字,09-17 真机被吞掉过)。
    .replace(/(^|[^\p{L}\p{N}_])(__?)(?=\S)(.+?)\2(?![\p{L}\p{N}_])/gu, '$1$3')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!~])/g, '$1')
    .trim()
}

export function summarizePlan(content: string): PlanSummary {
  let total = 0
  let done = 0
  let next: string | null = null
  const doneTexts: string[] = []
  for (const unit of parseUnits(content.split('\n'))) {
    if (!isList(unit) || unit.type !== 'task') continue
    total += 1
    const text = plainTaskText(unit.content)
    if (unit.done) {
      done += 1
      doneTexts.push(text)
    } else if (next === null) {
      next = text
    }
  }
  return { total, done, next, doneTexts }
}

/**
 * 两次读数之间新完成的那一项(按多重集比:同名的两项各算各的)。
 * 第一次读数(`before` 为 null)不算「刚完成」—— 打开会话时已经勾好的不是刚发生的事。
 */
export function newlyDone(before: readonly string[] | null, after: readonly string[]): string | null {
  if (before === null) return null
  const left = new Map<string, number>()
  for (const text of before) left.set(text, (left.get(text) ?? 0) + 1)
  for (const text of after) {
    const count = left.get(text) ?? 0
    if (count > 0) left.set(text, count - 1)
    else return text
  }
  return null
}
