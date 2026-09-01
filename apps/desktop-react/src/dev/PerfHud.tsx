import { useEffect, useState } from 'react'
import { dumpPerf, perfReport, subscribePerf, type PerfEntry } from '../services/perf'
import { overBudget } from '../perf-budget'
import { Button } from '../ui/Button'
import { ButtonBase } from '../ui/ButtonBase'
import { IconButton } from '../ui/IconButton'
import { X } from '../components/icons'
import { useT } from '../i18n'
import type { TFn } from '../i18n'
import s from './PerfHud.module.css'

/** localStorage 开关键:'1' 强制开、'0' 强制关、没表态走缺省档(dev 开 / 生产关)。 */
export const PERF_HUD_KEY = 'onething.perfHud'

/** 浮层里最多列几条。再多就得滚,而 HUD 滚起来自己就成了长帧的来源。 */
const VISIBLE = 8

/**
 * 开关判定。**缺省一律关**(08-30 二次拍板):曾短暂改成 dev 缺省开——那时
 * 「探针要会响」还没有别的出口;通知系统上线后,性能超预算走 notify(silent)
 * 进通知中心存档,探针有家了,HUD 回归它的本分 —— 显式打开的排障仪表,
 * 不再自动出面打扰。'1' 强制开('0' 作为显式关的历史值仍认)。
 *
 * localStorage 在隐私窗 / 禁站点数据时读会**抛**,不是返回 null ——
 * 所以这里 try/catch,读不到就当没开(HUD 缺席永远比白屏好)。
 */
export function perfHudEnabled(): boolean {
  try {
    return localStorage.getItem(PERF_HUD_KEY) === '1'
  } catch {
    return false
  }
}

/** 一条读数的行首那句话。三种 kind 各有各的句式,句式住在字典里。 */
export function rowLabel(t: TFn, entry: PerfEntry): string {
  if (entry.kind === 'longFrame') return t('perf.longFrame', { ms: entry.ms })
  if (entry.kind === 'span') return t('perf.span', { name: entry.name, ms: entry.ms })
  return t('perf.slowEvent', { name: entry.name, ms: entry.ms })
}

/**
 * 折叠态那一行小字 —— **一眼看得完的那点**。展开才给全量。
 * 长帧给最重的一段脚本,交互给目标元素,打点没有第二行可说。
 */
export function rowSummary(entry: PerfEntry): string | undefined {
  if (entry.kind === 'interaction') return entry.target
  const top = entry.scripts?.[0]
  if (!top) return undefined
  const rest = (entry.scripts?.length ?? 0) - 1
  return `${top.invoker} ${top.ms}ms${rest > 0 ? ` +${rest}` : ''}`
}

/** 展开区第一行:阶段拆分。它回答「脚本慢还是排版慢」。 */
export function phaseLine(entry: PerfEntry): string | undefined {
  const parts: string[] = []
  if (entry.blockingMs !== undefined) parts.push(`blocking ${entry.blockingMs}ms`)
  if (entry.renderMs !== undefined) parts.push(`render ${entry.renderMs}ms`)
  if (entry.styleAndLayoutMs !== undefined) parts.push(`style+layout ${entry.styleAndLayoutMs}ms`)
  if (entry.inputDelayMs !== undefined) parts.push(`input ${entry.inputDelayMs}ms`)
  if (entry.processingMs !== undefined) parts.push(`proc ${entry.processingMs}ms`)
  if (entry.presentationMs !== undefined) parts.push(`paint ${entry.presentationMs}ms`)
  return parts.length ? parts.join(' · ') : undefined
}

const entryKey = (e: PerfEntry) => `${e.ts}-${e.kind}-${e.name}-${e.ms}`

/**
 * 一条读数按哪一档预算判红。**与探针里 `limitFor` 是同一句判断**:
 * 打点(span)与长帧同线 —— 一段函数吃掉一整帧,就是一帧的事。
 * 预算表本身不为 span 新开一档,它只有两档。
 */
const budgetKindOf = (e: PerfEntry): 'longFrame' | 'interaction' =>
  e.kind === 'interaction' ? 'interaction' : 'longFrame'

/**
 * dev 性能 HUD —— 一块可开关的小浮层,显示最近的读数与它们的归因。
 *
 * 它读的是 `services/perf.ts` 那一个环,报警色读的是 `perf-budget.ts` 那一份表 ——
 * 与 `scripts/gate-perf.mjs` 同源。所以「HUD 上是绿的但门是红的」不会发生。
 *
 * 自己不许成为被测对象的噪声:只订阅、不轮询,列表定长,
 * `pointer-events: none` 让它不吃任何点击(除了那几颗按钮)。
 *
 * ── 08-30 可观测性批:行可点开 ──────────────────────────────────────────
 * 折叠态仍然是一行一条(HUD 的本分是「余光扫一眼」),点开那条才铺开**完整**的
 * 脚本列表与源位置 —— 这正是从前最缺的那一段:光看 `TimerHandler:setTimeout`
 * 谁也不知道该去改哪一行。展开区允许在自己里面滚:滚它是**显式手势**,
 * 不是每帧都在发生的事,与「HUD 不许自己变成卡顿源」不冲突。
 * 头部那颗「聚合」把整个环按名字聚成 p50/p95/max 打进控制台 ——
 * 单条读数答「刚才那一下」,那张表答「一直以来谁最贵」。
 */
export function PerfHud() {
  const t = useT()
  const [entries, setEntries] = useState<PerfEntry[]>(() => dumpPerf().slice(-VISIBLE))
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => subscribePerf(() => setEntries(dumpPerf().slice(-VISIBLE))), [])

  if (!open) return null

  const worst = entries.reduce((max, e) => Math.max(max, e.ms), 0)
  const bad = entries.some((e) => overBudget(budgetKindOf(e), e.ms))

  return (
    <aside className={s.hud} data-testid="perf-hud">
      <header className={s.head}>
        <span className={s.title}>{t('perf.title')}</span>
        <span className={bad ? s.over : s.ok}>
          {bad ? t('perf.budgetOver') : t('perf.budgetOk')}
          {worst > 0 ? ` · ${worst}ms` : ''}
        </span>
        {/* 「聚合」是文字动作钮 → `ui/Button`(ghost);本地 `.report` 只补落点
          * 几何(HUD 通体 fs-nano,库件那 28px 高会把这条檐撑开一倍)。 */}
        <Button
          className={s.report}
          data-testid="perf-hud-report"
          aria-label={t('perf.reportHint')}
          onClick={() => {
            // eslint-disable-next-line no-console -- HUD 的「聚合」就是往控制台打表
            console.table(perfReport())
          }}
        >
          {t('perf.report')}
        </Button>
        {/* 关掉 HUD 是图标钮 → `ui/IconButton`(xs 档);字形从字面的 `×`
          * 换成 lucide 的 X —— 全壳图标钮只有一个字形产地。 */}
        <IconButton
          icon={X}
          size="xs"
          className={s.close}
          label={t('perf.close')}
          onClick={() => setOpen(false)}
        />
      </header>
      {entries.length === 0 ? (
        <p className={s.empty}>{t('perf.empty')}</p>
      ) : (
        <ul className={s.list}>
          {entries.map((e) => {
            const key = entryKey(e)
            const on = expanded === key
            const summary = rowSummary(e)
            const phases = phaseLine(e)
            return (
              <li key={key} className={s.row}>
                {/* 整行是一颗按钮,长得就是那一行本身 → 结构件,`ui/ButtonBase`。 */}
                <ButtonBase
                  className={s.rowBtn}
                  aria-expanded={on}
                  aria-label={t('perf.rowDetail')}
                  onClick={() => setExpanded(on ? null : key)}
                >
                  <span className={overBudget(budgetKindOf(e), e.ms) ? s.over : s.ok}>
                    {rowLabel(t, e)}
                  </span>
                  {/* 折叠态的一行小字。没有归因(跨域 / 浏览器没给)就不画。 */}
                  {summary ? <span className={s.attr}>{summary}</span> : null}
                </ButtonBase>
                {on ? (
                  <div className={s.detail}>
                    {phases ? <p className={s.phase}>{phases}</p> : null}
                    {e.scripts?.length ? (
                      <ol className={s.scripts}>
                        {e.scripts.map((script, i) => (
                          <li key={`${script.invoker}-${script.at ?? ''}-${i}`} className={s.script}>
                            <span className={s.scriptHead}>
                              {script.invoker} {script.ms}ms
                            </span>
                            {script.fn ? <span className={s.scriptAt}>fn={script.fn}</span> : null}
                            {script.at ? <span className={s.scriptAt}>{script.at}</span> : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {e.interactionId ? (
                      <p className={s.phase}>interactionId {e.interactionId}</p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
