import { useEffect, useState } from 'react'
import { dumpPerf, subscribePerf, type PerfEntry } from '../services/perf'
import { overBudget } from '../perf-budget'
import { useT } from '../i18n'
import s from './PerfHud.module.css'

/** localStorage 开关键:'1' 强制开、'0' 强制关、没表态走缺省档(dev 开 / 生产关)。 */
export const PERF_HUD_KEY = 'onething.perfHud'

/** 浮层里最多列几条。再多就得滚,而 HUD 滚起来自己就成了长帧的来源。 */
const VISIBLE = 8

/**
 * 开关判定。**dev 缺省开,生产缺省关**(08-30 拍板「探针要会响」):切 tab 卡顿
 * 那一单里,探针环里躺着一排 200ms+ 的长帧,却因为 HUD 默认关、没人 dump,
 * 一直等到用户来报手感 —— 只记不响的探针等于没装。dev 是长帧的放大镜
 * (StrictMode 双渲染 + 开发运行时),也是它该最先响的地方;生产窗口仍然
 * 只在显式 '1' 时出现,它终究是排障工具,不是产品的一块界面。
 *
 * localStorage 在隐私窗 / 禁站点数据时读会**抛**,不是返回 null ——
 * 所以这里 try/catch,读不到就当没开(HUD 缺席永远比白屏好)。
 */
export function perfHudEnabled(): boolean {
  try {
    const flag = localStorage.getItem(PERF_HUD_KEY)
    if (flag === '1') return true
    if (flag === '0') return false
    return Boolean(import.meta.env.DEV)
  } catch {
    return false
  }
}

/**
 * dev 性能 HUD —— 一块可开关的小浮层,显示最近的长帧与它们的归因。
 *
 * 它读的是 `services/perf.ts` 那一个环,报警色读的是 `perf-budget.ts` 那一份表 ——
 * 与 `scripts/gate-perf.mjs` 同源。所以「HUD 上是绿的但门是红的」不会发生。
 *
 * 自己不许成为被测对象的噪声:只订阅、不轮询,列表定长不滚动,
 * `pointer-events: none` 让它不吃任何点击(除了那颗关闭按钮)。
 */
export function PerfHud() {
  const t = useT()
  const [entries, setEntries] = useState<PerfEntry[]>(() => dumpPerf().slice(-VISIBLE))
  const [open, setOpen] = useState(true)

  useEffect(() => subscribePerf(() => setEntries(dumpPerf().slice(-VISIBLE))), [])

  if (!open) return null

  const longFrames = entries.filter((e) => e.kind === 'longFrame')
  const worst = entries.reduce((max, e) => Math.max(max, e.ms), 0)
  const bad = entries.some((e) => overBudget(e.kind, e.ms))

  return (
    <aside className={s.hud} data-testid="perf-hud">
      <header className={s.head}>
        <span className={s.title}>{t('perf.title')}</span>
        <span className={bad ? s.over : s.ok}>
          {bad ? t('perf.budgetOver') : t('perf.budgetOk')}
          {worst > 0 ? ` · ${worst}ms` : ''}
        </span>
        <button
          type="button"
          className={s.close}
          aria-label={t('perf.close')}
          onClick={() => setOpen(false)}
        >
          ×
        </button>
      </header>
      {longFrames.length === 0 ? (
        <p className={s.empty}>{t('perf.empty')}</p>
      ) : (
        <ul className={s.list}>
          {longFrames.map((e) => (
            <li key={`${e.ts}-${e.ms}`} className={s.row}>
              <span className={overBudget(e.kind, e.ms) ? s.over : s.ok}>
                {t('perf.longFrame', { ms: e.ms })}
              </span>
              {/* 归因摘要:一帧里最重的那几段脚本。没有归因(跨域 / 浏览器没给)就不画。 */}
              {e.scripts?.length ? (
                <span className={s.attr}>
                  {e.scripts.map((x) => `${x.invoker} ${x.ms}ms`).join(' · ')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
