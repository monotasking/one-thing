import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useT } from '../../i18n'
import { useComposerStore } from '../store'
import {
  askAllAnswered,
  askAnswerText,
  askAnsweredCount,
  askMaxRows,
  isCustomAnswer,
} from '../transitions'
import type { AskSpec } from '../types'
import s from './Composer.module.css'

/** 一条横条的行高与行距 —— 与 --ask-row-h / --ask-row-gap 是同一份事实。 */
const ROW_H = 36
const ROW_GAP = 5

/**
 * ask 形态:本体行整个变成一张问卷。**它不走抽屉** ——
 * 该你回答的时候,回答就是输入框本身,而不是输入框上面弹出来的一块东西。
 *
 * 四条设计裁定照搬:
 * 1. 选项是**横条**,单选圆点、多选方记号 —— 记号的形状就是「能不能多选」的说明书;
 * 2. 单选**再点即取消**:答错了不必找「清除」;
 * 3. 每题底下**永远多一条「其他」**,就在行里写、回车即答,不新开输入框;
 * 4. 几何钉死:按选项最多的那题预留高度,翻题时面板一动不动。
 */
export function AskForm({ spec }: { spec: AskSpec }) {
  const t = useT()
  const answers = useComposerStore((st) => st.askAnswers)
  const idx = useComposerStore((st) => st.askIdx)
  const answer = useComposerStore((st) => st.answerAsk)
  const setCustom = useComposerStore((st) => st.setAskCustom)
  const move = useComposerStore((st) => st.moveAsk)
  const submit = useComposerStore((st) => st.submitAsk)
  const reject = useComposerStore((st) => st.rejectAsk)
  const freeRef = useRef<HTMLSpanElement>(null)

  const question = spec.questions[idx]
  if (!question) return null

  const ans = answers[idx]
  const picked = new Set(Array.isArray(ans) ? ans : [])
  const customOn = isCustomAnswer(question, ans)
  const done = askAnsweredCount(answers)
  const all = askAllAnswered(spec, answers)
  const rows = askMaxRows(spec)

  const onFreeKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    setCustom(freeRef.current?.textContent ?? '')
  }

  const onSubmit = () => {
    submit(
      spec.questions.map((q, i) => ({
        tag: q.tag,
        answer: askAnswerText(q, answers[i], t('ask.joiner')),
      })),
    )
  }

  return (
    <div className={s.askForm}>
      <div className={s.askTop}>
        <button
          type="button"
          className={s.askArrow}
          aria-label={t('ask.prev')}
          disabled={idx === 0}
          onClick={() => move(-1)}
        >
          ‹
        </button>
        <span className={s.askStep}>
          {t('ask.step', { index: idx + 1, total: spec.questions.length })}
        </span>
        <button
          type="button"
          className={s.askArrow}
          aria-label={t('ask.next')}
          disabled={idx === spec.questions.length - 1}
          onClick={() => move(1)}
        >
          ›
        </button>
        <span className={s.askQ}>
          {question.q}
          {question.multi && <span className={s.askMulti}>{t('ask.multi')}</span>}
        </span>
        <button type="button" className={s.askReject} onClick={reject}>
          {t('ask.reject')}
        </button>
      </div>

      <div
        className={s.askBars}
        style={{ minHeight: `${rows * ROW_H + (rows - 1) * ROW_GAP}px` }}
      >
        {question.opts.map((o, i) => {
          const on = question.multi ? picked.has(i) : ans === o.l
          const mark = [s.askMark, question.multi ? s.askMarkSquare : '', on ? s.askMarkOn : '']
            .filter(Boolean)
            .join(' ')
          return (
            <button
              key={o.l}
              type="button"
              className={on ? `${s.askBar} ${s.askBarOn}` : s.askBar}
              aria-pressed={on}
              onClick={() => answer(i)}
            >
              <span className={mark} aria-hidden="true" />
              <span className={s.askLabel}>{o.l}</span>
              <span className={s.askDesc}>{o.d}</span>
            </button>
          )
        })}

        {/* 「其他」行:点记号 = 取消这句自定义答案,点行内文字 = 直接改,不新开输入框。 */}
        <div className={customOn ? `${s.askBar} ${s.askBarOn} ${s.askOther}` : `${s.askBar} ${s.askOther}`}>
          <span
            className={customOn ? `${s.askMark} ${s.askMarkOn}` : s.askMark}
            role="button"
            tabIndex={0}
            aria-label={t('ask.other')}
            onClick={() => (customOn ? setCustom('') : freeRef.current?.focus())}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              if (customOn) setCustom('')
              else freeRef.current?.focus()
            }}
          />
          <span className={s.askLabel}>{t('ask.other')}</span>
          <span
            key={`free-${idx}-${customOn ? 'on' : 'off'}`}
            ref={freeRef}
            className={s.askFree}
            contentEditable
            tabIndex={0}
            suppressContentEditableWarning
            role="textbox"
            aria-label={t('ask.otherPlaceholder')}
            data-placeholder={t('ask.otherPlaceholder')}
            onKeyDown={onFreeKey}
          >
            {customOn && typeof ans === 'string' ? ans : ''}
          </span>
        </div>
      </div>

      <div className={s.askFoot}>
        <span className={s.askEsc}>{t('ask.hint')}</span>
        <button
          type="button"
          className={s.askSubmit}
          disabled={!all}
          onClick={onSubmit}
        >
          {t('ask.submit', { done, total: spec.questions.length })}
        </button>
      </div>
    </div>
  )
}
