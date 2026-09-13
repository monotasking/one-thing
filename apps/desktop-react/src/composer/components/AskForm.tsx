import type { KeyboardEvent, RefObject } from 'react'
import { useFocusScope } from '../../focus/useFocusScope'
import { useT } from '../../i18n'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { useComposerStoreOf } from '../store'
import { useComposerSessionId } from '../session-context'
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
export function AskForm({
  spec,
  freeRef,
}: {
  spec: AskSpec
  /**
   * 「其他」那一格自由输入。**由输入面板持有**(它是这一形的落点,见 Composer 的
   * `restingTarget`)—— 这一层因此不再自己 `.focus()`:点记号 = 一句 `activate()`,
   * 焦点落到哪儿由那一格声明答。设计 §7:跨作用域搬焦点谁都不许,作用域内部的
   * 移动走落点。
   */
  freeRef: RefObject<HTMLSpanElement | null>
}) {
  const t = useT()
  /* 这块面板对着哪条会话 —— 由 `Composer` 下发(W5-c-2)。 */
  const sessionId = useComposerSessionId()
  const answers = useComposerStoreOf(sessionId, (st) => st.askAnswers)
  const idx = useComposerStoreOf(sessionId, (st) => st.askIdx)
  const answer = useComposerStoreOf(sessionId, (st) => st.answerAsk)
  const setCustom = useComposerStoreOf(sessionId, (st) => st.setAskCustom)
  const move = useComposerStoreOf(sessionId, (st) => st.moveAsk)
  const submit = useComposerStoreOf(sessionId, (st) => st.submitAsk)
  const reject = useComposerStoreOf(sessionId, (st) => st.rejectAsk)
  /** 这块表单住在输入面板那一格作用域里,所以拿到的是它的句柄。 */
  const { activate } = useFocusScope()

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
        {/* ‹ › 是**画在字面上**的一对翻页记号(圆形描边、字号 fs-label),
          * 不是 lucide 图标钮 —— 视觉本该定制,所以走裸钮三类判第③类
          * `ui/ButtonBase`(只清 UA),`.askArrow` 那份皮肤一个像素不动。 */}
        <ButtonBase
          className={s.askArrow}
          aria-label={t('ask.prev')}
          disabled={idx === 0}
          onClick={() => move(-1)}
        >
          ‹
        </ButtonBase>
        <span className={s.askStep}>
          {t('ask.step', { index: idx + 1, total: spec.questions.length })}
        </span>
        <ButtonBase
          className={s.askArrow}
          aria-label={t('ask.next')}
          disabled={idx === spec.questions.length - 1}
          onClick={() => move(1)}
        >
          ›
        </ButtonBase>
        <span className={s.askQ}>
          {question.q}
          {question.multi && <span className={s.askMulti}>{t('ask.multi')}</span>}
        </span>
        {/* 「拒绝」是文字动作钮 → `ui/Button` 的 **danger** 档(09-01 批 3.5:
          * 批 3 迁进库件时因为库件没有这一档而退役的危险语义,回填在这里)。
          * 本地只留一格落点(`margin-left: auto`,把它顶到行尾);
          * rest / hover / disabled / 焦点环全部随件走。 */}
        <Button variant="danger" className={s.askReject} onClick={reject}>
          {t('ask.reject')}
        </Button>
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
            /* 选项横条 = 裸钮三类判第③类(结构性交互件)→ `ui/ButtonBase`。 */
            <ButtonBase
              key={o.l}
              className={on ? `${s.askBar} ${s.askBarOn}` : s.askBar}
              aria-pressed={on}
              onClick={() => answer(i)}
            >
              <span className={mark} aria-hidden="true" />
              <span className={s.askLabel}>{o.l}</span>
              <span className={s.askDesc}>{o.d}</span>
            </ButtonBase>
          )
        })}

        {/* 「其他」行:点记号 = 取消这句自定义答案,点行内文字 = 直接改,不新开输入框。 */}
        {/* 文本载体:同一条横条上那枚记号落焦时不点亮它 —— 判据只认能打字的那个。 */}
        <div
          className={customOn ? `${s.askBar} ${s.askBarOn} ${s.askOther}` : `${s.askBar} ${s.askOther}`}
          data-focus-ring="text"
        >
          <span
            className={customOn ? `${s.askMark} ${s.askMarkOn}` : s.askMark}
            /* 选中的记号是强调色实心,环得换一档才看得见。 */
            data-focus-ring-tone={customOn ? 'on-accent' : undefined}
            role="button"
            tabIndex={0}
            aria-label={t('ask.other')}
            /*
             * 点记号 = **取消这句自定义答案**;还没写过就把光标送进那一行。
             * 「送进去」走 `activate()`(输入面板的落点在 ask 形态下就是那一行),
             * 不再自己 `.focus()` —— 落点是声明,不是每个调用方各记一遍。
             */
            onClick={() => (customOn ? setCustom('') : activate('open'))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              if (customOn) setCustom('')
              else activate('open')
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
        {/* 提交是这张表上唯一的主动作 → `ui/Button` 的 primary + pill
          * (从前那份 accent 实底 + r-full 的手写皮肤逐字就是这两档)。 */}
        <Button
          variant="primary"
          pill
          className={s.askSubmit}
          disabled={!all}
          onClick={onSubmit}
        >
          {t('ask.submit', { done, total: spec.questions.length })}
        </Button>
      </div>
    </div>
  )
}
