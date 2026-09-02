import { createContext, useContext, useId, useMemo } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import s from './Field.module.css'

/**
 * **表单行**(09-01 批 2a 第 4 件,视觉词汇立件)。
 *
 * 一行 = 标签 / 控件 / 说明 / 错误。四件事里有三件是**文字**,
 * 唯一开放的那件(控件)走 children —— 与 Card 同一条判据(09-01 库自审立法):
 * 项里装什么由消费方说了算的走复合 children,封闭集合才走数据表。
 *
 * ── 关联为什么走 context + hook,不走 cloneElement ──────────────────────
 * `cloneElement` 那条路要求「children 恰好是一个元素、并且它把收到的
 * id / aria-* 原样透传到真正的那个 <input> 上」。两个前提都不成立:
 *  · 一格里常常是**两件**(输入框 + 一颗「测试连接」钮),单子假设当场破;
 *  · 更坏的是**覆盖病**:注入的 props 与消费方自己写的同名 props 谁赢,
 *    由 cloneElement 的合并次序决定 —— 这正是 Tooltip 刚修过的那一类
 *    (09-01,`ui/Tooltip` 把 cloneElement 注入改掉的判例)。
 * context + hook 把主动权交回消费方:它自己决定把这组 props 摊在哪一件上、
 * 摊在自己的 props 之前还是之后。代价是**得记得调用**,所以这条写进
 * `useFieldControlProps` 的注释里,规格页(dev/Gallery)也照这个用法演。
 *
 * ── 三类状态(库件规格)────────────────────────────────────────────────
 *   生命状态:id 由 `useId` 一次性给,跨渲染稳定(重渲不换 id = label 的
 *             htmlFor 不会指空);无订阅 / 无计时器 / 无模块级副作用 →
 *             不需要 HMR dispose。`hint` / `error` 缺席时**那一格不渲染 DOM**
 *             (不是渲染空壳:空壳会在 column flex 里多吃一个 gap,
 *             一列表单行的行距就参差了)。
 *   交互状态:这件自己**不是控件**,没有 rest/hover/focus/disabled ——
 *             那些都归它装着的那件控件(ui/Input 等)。它管的是
 *             error 在场 / 不在场时控件拿到的 aria 是不是跟着变。
 *   数据状态:rest / 只有 hint / 只有 error / hint 与 error 并存
 *             (并存时 aria-describedby 两个 id 都在,**错误排在前面** ——
 *             读屏软件按顺序念,先说「错在哪」再说「该怎么填」)。
 *
 * ── 不可标注的控件走 `aria-labelledby`(09-02 批 8a 补口)──────────────────
 * `<label htmlFor>` 只认**可标注元素**(input / select / textarea / button / …)。
 * 一格里装的若是 `role="radiogroup"` 那一族(`ui/Segmented`,它的根是个 `<div>`),
 * `htmlFor` 就指了个空:点标签不聚焦,读屏软件念不出这一组叫什么。
 * 修法不是让库件去吃库件的 context(`ui/Segmented` 自己 `useFieldControlProps()`
 * 是隐式耦合:一件基础件凭空多出一个「必须长在 Field 里」的前提),
 * 而是**把 label 自己的 id 一起交出去**:控件 props 里多一格 `aria-labelledby`,
 * 消费方照旧一句 `<Segmented {...field} />` 就关联上了 —— 主动权仍在消费方手里,
 * 与本件不用 cloneElement 是同一条理由。
 *
 * 两格并存不打架:`<input id=X aria-labelledby=L>` 与 `<label for=X id=L>` 指的是
 * 同一段文字,可访问名算出来逐字相同(aria-labelledby 优先,内容一样)。
 * 所以这一格是**加性**的 —— 既有的可标注控件一个字都不用改。
 *
 * ── 为什么开横排档(09-02 批 10;同一个缺口撞了三次才开)──────────────────
 * 从前这件只有竖排一形,而且 `label` 必须**画出来**。于是仓里长出了三处
 * 各写各的横排表单行,三处都在自己的文件头里写下「不迁 Field,因为它是竖排 /
 * 因为它要一句凭空造的可见标签」:
 *  · `workspace/components/WorkspaceOverview` 的改名格(icon 钮 + 输入框并肩);
 *  · `providers/components/AddModelRow`(输入框 + 提交钮并肩,错误跟在后面);
 *  · `content/files/NoWorkdirNotice` 的绑定行(输入框 + 两颗钮,错误折第二行)。
 * 三处的代价一模一样:**错误那句话没有跟输入框关联**(没有 `aria-describedby`),
 * 读屏软件读得到边线转红却读不到原因。一个缺口撞三次就不是巧合是缺件 ——
 * 编排裁定开档,三处收编。
 *
 * 开的是**两格 props**,不是一条 className 逃生口:
 *  · `layout`:形是这件自己的事。让消费方从外面覆盖 `flex-direction` 是特异性
 *    赌局(两边都是单类,谁赢取决于打包器把哪份 module.css 排在后面)——
 *    AddModelRow 的文件头把这条理由写得最清楚,开档正是为了消掉它。
 *  · `labelHidden`:名字**永远要有**(读屏软件靠它念这一格叫什么),
 *    看不看得见是另一件事。所以不是「label 可选」,是「label 可以只念不看」。
 *    三处产地里有两处正是这一档(它们今天写的是 `aria-label`)。
 * 与 Card 的 `actions` 同一条判据(09-01 库自审立法):**封闭的形走 props**,
 * 只有「里面装什么由消费方说了算」的那一格才走 children。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface FieldControlProps {
  id?: string
  /**
   * 这一格 `<label>` 自己的 id。**可标注的控件用不上它**(htmlFor 已经够了),
   * 它是给 radiogroup / listbox 那一族「`htmlFor` 指不动」的控件用的出口。
   */
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

/** 不在 Field 里时是一个空对象:摊上去等于什么都没发生,不抛、不警告。 */
const EMPTY: FieldControlProps = {}

const FieldContext = createContext<FieldControlProps>(EMPTY)

/**
 * 把这一格的 id / aria 关联摊到你自己的控件上:
 *
 * ```tsx
 * function ApiKeyBox() {
 *   const field = useFieldControlProps()
 *   return <Input {...field} value={v} onValueChange={setV} />
 * }
 * ```
 *
 * **必须调用**:Field 的 `<label htmlFor>` 指的就是这里给的 id,不摊上去
 * 那条 label 就指空了(点标签不聚焦、读屏软件读不出控件的名)。
 * 在 Field 外调用是合法的 —— 拿到空对象,摊上去什么都不发生。
 */
export function useFieldControlProps(): FieldControlProps {
  return useContext(FieldContext)
}

/**
 * 透传口子:**落点自己的身份**(`data-testid` / `role` / `aria-*`),照
 * `ui/GroupHead` / `ui/Segmented` 的既有先例。「这一行在测试里叫什么」是消费面的
 * 裁定,不该一条一条变成这件的 prop —— 收编 `content/files` 那条绑定行时它是真需求
 * (`data-testid="files-bind-row"` 是那一行的名牌,八条既有测试按它找人)。
 * **样式仍然只走 `className` 皮肤**:透传不是 `style={{…}}` 的口子。
 * `children` 不透传(它是这件自己的槽,收了只会被静默丢掉)。
 */
export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * 这一格的名字。**恒为必填** —— 一个没有名字的控件读屏软件念不出来。
   * 不想画出来时给 `labelHidden`,而不是不给它。
   */
  label: ReactNode
  /**
   * 标签**只念不看**:视觉隐藏、读屏可得(全局 `.visually-hidden`,与
   * `ui/a11y/live-region` 同一手)。用在名字已经由上下文说清、再画一遍是噪音
   * 的横排行上 —— 但关联一格不少(`htmlFor` / `aria-labelledby` 照旧)。
   *
   * 不用 `display:none` / `visibility:hidden`:那两个连读屏软件一起藏,
   * 那是藏起来,不是「只说给听的人」。
   */
  labelHidden?: boolean
  /**
   * 形。`stack`(缺省)= 标签在上控件在下;`inline` = 标签与控件同一行、
   * 附注折到第二行占满宽。**横排也能装不止一件**:控件那一格是 children,
   * 并肩的钮跟着进去就行(三处产地里三处都是这样)。
   */
  layout?: 'stack' | 'inline'
  /** 档:`md`(缺省)常规 / `sm` 紧凑。一个旋钮同时定间距与附注字号,理由见 module.css。 */
  size?: 'sm' | 'md'
  /** 弱色说明。 */
  hint?: ReactNode
  /** 错误。**危险色只上字不上底**;在场时控件同时拿到 aria-invalid。 */
  error?: ReactNode
  className?: string
  children?: ReactNode
}

export function Field({
  label,
  labelHidden = false,
  layout = 'stack',
  size = 'md',
  hint,
  error,
  className,
  children,
  ...rest
}: FieldProps) {
  const base = useId()
  const controlId = `${base}control`
  const labelId = `${base}label`
  const hintId = `${base}hint`
  const errorId = `${base}error`

  const hasHint = hint != null
  const hasError = error != null

  const control = useMemo<FieldControlProps>(() => {
    // 错误排在 hint 前面:读屏软件按 describedby 的顺序念。
    const described = [hasError ? errorId : null, hasHint ? hintId : null].filter(Boolean)
    return {
      id: controlId,
      // 恒在,不看控件是哪一族:这件不知道消费方要往里塞什么,而多给一格
      // 指向同一段文字的 aria-labelledby 对可标注控件是无害的(名字算出来一样)。
      'aria-labelledby': labelId,
      'aria-describedby': described.length ? described.join(' ') : undefined,
      'aria-invalid': hasError ? true : undefined,
    }
  }, [controlId, labelId, errorId, hintId, hasError, hasHint])

  return (
    <div
      {...rest}
      className={[s.field, s[layout], s[size], className ?? ''].filter(Boolean).join(' ')}
    >
      {/*
       * 只念不看时**换掉**类名而不是叠上去:`.visually-hidden` 是 position:absolute,
       * 它因此不是这一行的 flex 项 —— 横排里不吃 gap、不占位,几何逐像素不变。
       * 字号/颜色对一个被裁到 1px 的框毫无意义,叠着只是多一份说谎的声明。
       */}
      <label
        className={labelHidden ? 'visually-hidden' : s.label}
        id={labelId}
        htmlFor={controlId}
      >
        {label}
      </label>
      <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
      {/* 空槽不渲染 DOM —— 理由见文件头「生命状态」。 */}
      {hasHint ? (
        <span className={s.hint} id={hintId}>
          {hint}
        </span>
      ) : null}
      {hasError ? (
        <p className={s.error} id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  )
}
