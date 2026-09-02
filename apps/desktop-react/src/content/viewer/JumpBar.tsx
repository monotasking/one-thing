import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { Input } from '../../ui/Input'
import { FocusScope } from '../../focus/FocusScope'
import { useListSelection } from '../../ui/a11y/list-selection'
import { useT } from '../../i18n'
import type { ViewerFile } from '../../data/viewer-source'
import { listNavigators, navigatorFor } from './registry'
import s from './FileViewer.module.css'

/**
 * **⌘L 跳转条 —— 跳转的唯一入口**(定稿)。
 *
 * 屏幕上它只是一条输入 + 几行候选,但它买到的是一条结构性质的东西:「跳到某处」
 * 在这台上永远是**同一件事、同一条路、同一套键**。行号、符号、检索命中、diff
 * 的上一处下一处 —— 它们的差别只在「这串字对应哪几行」,而那正是 navigator 的
 * 全部职责(registry.ts)。滚动、高亮当前行、关掉自己,统统归壳。
 *
 * ── ⌘F 也走这一条(F2)────────────────────────────────────────────────────
 * 「查看器内检索」不是第二块 UI:⌘F 开的就是这条跳转条,只是把 `/` 前缀先替
 * 用户打上(`initialQuery`)。于是命中列表、跳行、当前行高亮、Esc 关掉这四件事
 * 检索一件都不用自己再实现一遍 —— 少一套 UI,就少一处会分叉的手感。
 *
 * ── 走一遍命中 vs 落一次点(navigator.cycle)──────────────────────────────
 * 检索档的候选是**一串要走一遍的东西**,行号档的候选是一个落点。所以:
 *  · cycle 档:↵ 落点之后**条不关**,active 往下挪一格、到底绕回第一个 ——
 *    连按 ↵ 就是「下一个命中」;↑↓ 是不落点的浏览。
 *  · 非 cycle 档:↵ 落点即收(「跳到第 42 行」没有「下一个 42 行」)。
 * 判据在提供者身上,不在这里的一个 `id === 'search'`。
 *
 * ── 没接上的那几档**画出来**,不藏起来 ─────────────────────────────────────
 * 符号 `#` / diff `@` 两档已经在表里,但 `list` 缺席。输入它们的前缀时
 * 这里画一行灰的、写着「还没接上」——与「打开方式」那六档同一条诚实降级:
 * 藏起来的能力,接上那天没有人会去找它。
 *
 * 空输入时列出全部前缀当提示 —— 这条输入行没有别的地方能说出「还能怎么跳」。
 */
export function JumpBar({
  file,
  lineCount,
  initialQuery = '',
  onJump,
  onClose,
}: {
  file: ViewerFile
  lineCount: number
  /** 开条时先打上的那串字(⌘F 递 `/`;⌘L 递空)。 */
  initialQuery?: string
  /** 落一次点。**它不负责关条** —— 关不关由这一档是不是 cycle 说了算。 */
  onJump: (line: number) => void
  onClose: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState(initialQuery)
  const navigators = listNavigators()

  const navigator = query ? navigatorFor(query) : undefined
  const candidates = useMemo(() => {
    if (!navigator?.list || !query) return []
    return navigator.list(query, { file, lineCount })
  }, [navigator, query, file, lineCount])

  /**
   * 键盘位走 **`ui/a11y/list-selection`**(地基件之四),不自己写「加一减一取模」。
   *
   * 立法一句话:**hover 只是 hover,不许影响 select** —— 所以这张候选表一个
   * mouseenter 都不挂,鼠标经过只由 CSS 的 `:hover` 画。判例是同一份走法从前在
   * composer / 工作区快切 / 检索面 / 这条跳转条里各写了一遍,四份走法配着四份
   * hover 处理,于是「按 ↓ 一下跳了两行」那类病有四个产地。
   *
   * `loop: true` —— 检索档要的正是「到底绕回第一个」。
   * `homeEnd: false`(默认)—— 焦点恒在输入框里,Home/End 是「到行首 / 行尾」,
   * 抢走它就改不动搜索词了。
   * `scrollBlock: 'nearest'`(默认)—— 这张表有最大高度(--viewer-jump-max-h),
   * 选中项必须滚进视野(浮层列表那条禁令)。
   */
  const selection = useListSelection({ count: candidates.length, loop: true })

  /*
   * 换了一串字就是换了一组命中 —— 光标回到第一个,不留着上一组的下标。
   * 依赖**只有 query**:`select` 的身份跟着 commit 走,而候选表一变就重跑这条
   * effect 会把用户刚用 ↑↓ 走到的位子拽回第一条(原语文件头那段「落位不夹」
   * 说的正是这件事)。所以这里取一次动作、不订阅它。
   */
  const selectRef = useRef(selection.select)
  selectRef.current = selection.select
  useEffect(() => selectRef.current(0), [query])

  /** 这条的根。由 `<FocusScope rootRef>` 写进来(一个元素上只能有一格 ref)。 */
  const rootRef = useRef<HTMLDivElement | null>(null)

  /*
   * 一出现就把光标放进去 —— 用户刚按了 ⌘L / ⌘F,焦点跟着那一下走正是他要的结果。
   *
   * 从前这是一个回调 ref(同 FilesPanel 那条「绑定…」输入行的判例)。R1 换成
   * `useLayoutEffect` 不是风格改动,是**次序**:回调 ref 在提交阶段就跑,那时
   * 这一层的 `<FocusScope>` 还没登记完,焦点落进输入框时树里根本没有「跳转条」
   * 这一格 —— 第一响应者会被算成外面那块面,于是 Esc 再也退不到这一层。
   * layout effect 在子(FocusScope)的登记之后、浏览器绘制之前跑,两头都对。
   * 用户看到的一模一样:两者之间没有一次绘制。
   */
  useLayoutEffect(() => {
    const input = rootRef.current?.querySelector('input')
    if (!input) return
    input.focus()
    // 光标落到**末尾**而不是选中全文:⌘F 已经替用户打了一个 `/`,
    // 选中它意味着下一个字符会把前缀吃掉,那条路当场变成行号档。
    const at = input.value.length
    input.setSelectionRange(at, at)
  }, [])

  const cycling = navigator?.cycle === true
  const at = selection.active

  /** ↵ 的全部语义。cycle 档走一格不关条,别的档落点即收。 */
  const commit = () => {
    const hit = candidates[at]
    if (!hit) return
    onJump(hit.line)
    if (!cycling) {
      onClose()
      return
    }
    selection.move(1)
  }

  /*
   * ── Esc 关掉:响应链的 `float` 一层(09-02 R1)────────────────────────────
   *
   * 从前这里先是一段手写的 window keydown 捕获 + `stopPropagation()`,09-02 批 6
   * 迁进 `ui/float` 的 `useFloatDismiss`(浮层栈判「谁在最上面」)。两版都是在
   * 没有树的时候回答同一个问题:**这一下 Esc 属于最上面的哪一层**。
   * 树里那个问题有结构答案:跳转条是查看器上开出来的一层,所以它在树上就是
   * 查看器(或此刻装着查看器的那一层)的孩子,由深到浅第一个被问到。
   * 查看器还能摆进浮窗 / 盖 / 舞台,而这一层不必知道自己被摆在哪儿 —— 这正是
   * 浮层栈当年要用「DOM 包含 + 入栈序」两条判据去猜的那件事。
   *
   * **这条不点外关**,原样保留今天的行为:跳转条只被 Esc、落一次点(非 cycle 档)
   * 或再按一次 ⌘L 关掉。鼠标点到查看器正文上不该收掉它(正文那一下多半正是用户
   * 想看清楚要跳哪儿)—— 所以这里连 `useFloatDismiss` 都不用了(它的另一半
   * `outside` 本来就关着)。
   *
   * 入焦仍写在这块面自己身上(上面那条 layout effect),没有换成 `restingTarget`
   * —— R1 只做最小接入,R2 把内容面整体迁进树时再统一。理由:**光标落在末尾**
   * 那一手(⌘F 已经替用户打了一个 `/`)是这条输入行自己的语义,搬家时要连着一起搬。
   */
  return (
    <FocusScope scope="jumpbar" rootRef={rootRef} onEscape={() => (onClose(), true)}>
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.jump} data-testid="viewer-jump-bar">
          <Input
            size="sm"
            className={s.jumpInput}
            value={query}
            onValueChange={setQuery}
            aria-label={t('viewer.jumpLabel')}
            placeholder={t('viewer.jumpPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
                return
              }
              // ↑↓ 归原语管;它没接住的键**原样放行**(吞掉不认识的键是「键盘可达」
              // 最常见的反面教材)。
              if (selection.handleKey(e.key)) e.preventDefault()
            }}
          />
          {/* 「第几个 / 共几个」。它是**读数不是文案**里的数,所以句子进字典、数进插值。 */}
          {cycling && candidates.length > 0 && (
            <span className={s.jumpCount} data-testid="viewer-jump-count">
              {t('viewer.jumpHitCount', { index: `${at + 1}`, total: `${candidates.length}` })}
            </span>
          )}
          {cycling && query.length > 1 && candidates.length === 0 && (
            <span className={s.jumpCount} data-testid="viewer-jump-empty">
              {t('viewer.jumpNoHit')}
            </span>
          )}
          <ul className={s.jumpList} data-testid="viewer-jump-list">
            {!query &&
              navigators.map((nav) => (
                <li key={nav.id} className={s.jumpHint}>
                  <span className={s.jumpSigil}>{nav.sigil || '123'}</span>
                  <span className={s.jumpLabel}>{t(nav.labelKey)}</span>
                  {!nav.list && <span className={s.jumpSoon}>{t('files.openModeSoon')}</span>}
                </li>
              ))}
            {query && navigator && !navigator.list && (
              <li className={s.jumpHint} data-testid="viewer-jump-soon">
                <span className={s.jumpLabel}>{t(navigator.labelKey)}</span>
                <span className={s.jumpSoon}>{t('files.openModeSoon')}</span>
              </li>
            )}
            {candidates.map((candidate, index) => (
              <li key={candidate.id} ref={selection.rowRef(index)}>
                {/*
                 * 结构件(一行候选),视觉本该定制 —— 所以它消费 `ui/ButtonBase`
                 * (只清 UA、一个像素都不画),而不是 `ui/Button`。
                 * **点击是显式落位**,可以改键盘位;鼠标经过不行(那是 CSS 的事)。
                 */}
                <ButtonBase
                  className={index === at ? `${s.jumpRow} ${s.jumpRowOn}` : s.jumpRow}
                  data-jump-active={index === at ? 'true' : undefined}
                  onClick={() => {
                    selection.select(index)
                    onJump(candidate.line)
                    if (!cycling) onClose()
                  }}
                >
                  <span className={s.jumpLabel}>{candidate.label}</span>
                  {candidate.hint && <span className={s.jumpSoon}>{candidate.hint}</span>}
                </ButtonBase>
              </li>
            ))}
          </ul>
        </div>
      )}
    </FocusScope>
  )
}
