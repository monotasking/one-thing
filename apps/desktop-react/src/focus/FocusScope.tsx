import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
} from 'react'
import { focusTree } from './registry'
import type { ReactNode } from 'react'
import type { FocusScopeHandle } from './registry'
import type { CommandId } from '../keymap/types'
import type { ActivateReason, FocusInstanceId, FocusScopeId } from './types'

/**
 * **树怎么长出来**(设计 §4.1):`<FocusScope>` 既是一个 Provider,又向父
 * Provider 登记自己。父子关系来自**逻辑嵌套**而不是 DOM 位置 —— portal 到 body
 * 的菜单在 DOM 上是对话框的兄弟,在这棵树上是它的孩子。`ui/float.ts` 的
 * `topFloatLayer` 要用「DOM 包含 + 入栈序」两条判据去猜的,正是这件事。
 *
 * ── 硬约束:它**一个 DOM 节点都不许多加** ────────────────────────────────
 * region 与 layer 全都长在 grid / flex 里(三明治网格、聊天区、架子轨道),
 * 中间插一层 `<div>` 就会把布局掀了。所以这只组件只渲染 Provider(零 DOM),
 * 属性由 **render-prop** 交给消费方铺到它**自己**的根元素上:
 *
 * ```tsx
 * <FocusScope scope="root">
 *   {({ scopeProps }) => <div {...scopeProps} className={s.shell}>…</div>}
 * </FocusScope>
 * ```
 *
 * 只有这一种铺法(不再另开一条「从 hook 里取 scopeProps」的路):两种并存时,
 * 一个作用域会有两个地方能声称自己是根,I4「每个宿主层根元素都带
 * `data-focus-scope`」的判据当场变成「至少有一个地方带」。`useFocusScope()`
 * 因此只交出 `activate / instanceId`,没有 `scopeProps`(「我是不是当前」那一格
 * 09-04 S2 分了家,住进 `useFocusScopeActive()` —— 理由见那只文件的头);而
 * `<FocusScope>` 这一侧的 render-prop **只交 `scopeProps / activate / instanceId`**
 * —— 「我是不是当前」为什么不能从这里出,见下面那一节。
 *
 * ── 组件的 prop 叫 `scope` 不叫 `kind` ──────────────────────────────────
 * 设计文档里 `kind` 担了两份工(行为档 / 声明 id),拆名的理由写在 `types.ts`
 * 文件头。这里收的是**声明 id**,行为档从 `FOCUS_SCOPES` 那张表现查。
 *
 * ── `tabIndex` 为什么可能不在 `scopeProps` 里 ────────────────────────────
 * `tabIndex={-1}` 存在的唯一理由是「焦点能被送到根上」。R0 不搬焦点
 * (`FocusTree.policy.moveFocus === false`),此时铺它只会多出一个**可感知的**
 * 副作用:点空白处时 `activeElement` 从 `body` 变成那个根,`focus-trap` 记的
 * 锚点跟着变,Esc 回焦时有几率画出一圈焦点环。一个开关管一件事 —— R1 翻开关,
 * 行为与属性同时到位。`data-focus-scope` 不受这个闸管(I4 现在就要能扫)。
 *
 * 作用域根**不画焦点环**,那条唯一的容器例外与 09-13 立的其余四种载体并排住在
 * `styles/global.css` 的焦点环那一组里(判词随规则一起搬过去了;容器不是控件)。
 *
 * ── `rootRef`:DOM 上只有一格 ref(R1 补)────────────────────────────────
 * 消费方本来就常常有自己的一个 ref(浮层要量矩形定位、要判「点没点在我身上」),
 * 而一个元素上只能写一个 `ref` 属性。就地拼一个 `(el) => { mine.current = el;
 * scopeProps.ref(el) }` 会**每渲染一次换一个身份**,React 于是每渲染都先用 null
 * 调一次再用元素调一次 —— 根一摘一挂,树看到的是「根没了又回来了」。
 * 所以由这只组件一并写:传进来的 ref 与树的登记走**同一只回调**(身份恒定)。
 *
 * ── **为什么 `FocusScope` 自己不许订阅焦点树**(09-03,读数背书)──────────
 * 它是 render-prop 形、包住的是**一整块面**。一旦它自己
 * `useSyncExternalStore(focusTree.subscribe, …)` 去算「我在不在活动路径上」,
 * 那么每一次焦点换格,翻面的那两格 scope 就要把各自**整棵子树**重渲一遍 ——
 * 代价与它包住的东西成正比,不是与「谁需要这个布尔」成正比。
 * `probe-hotspots` 的读数:文件树开着时,单次 focusin 引出的同步 flush 从小树的
 * 0.94ms 涨到大树的 **5.45ms**(5.8×),那一段里 `TreeEntryRow` total 37.3ms、
 * `FocusScope` 自己 26.0ms —— 而当时全壳**没有一个消费者**读它交出去的 `isActive`
 * (grep 只找得到它自己)。
 *
 * 所以这个问题只有一个问法:**需要它的那个叶子自己 `useFocusScopeActive()`**。
 * 订阅仍在(那只 hook 里),粒度却变成了那一颗叶子;包着的面纹丝不动。
 *
 * 09-04 S2 把这条法推到底:订阅按**谁真的读那个布尔**算,不按**谁调过这只
 * hook**算 —— 从前 `useFocusScope()` 无条件挂着那格订阅,而壳里四个消费者
 * 一个都没读过 `isActive`,代价是焦点每换一次人整块总览重渲一遍(读数 80/80)。
 *
 * ── `activateOnMount`:开出来就把焦点送进落点 ────────────────────────────
 * 浮层的「开启即入焦」从前长在 `useFocusTrap`(容器档)与各面自己那句
 * `input.focus()` 里。树里它是一句声明:`activateOnMount` + `restingTarget`,
 * 落焦由 `activate('open')` 干 —— 设计 §7 说的「自己开的临时面不写任何
 * focus/keydown 代码」就是这一格。只在**挂载**时发一次:再开一次 = 一次新的挂载。
 */

/** 父作用域的实例 id。根之外的每一格都从这里拿自己的 parent。 */
export const FocusScopeContext = createContext<FocusInstanceId | null>(null)

/** render-prop 交出去的东西。 */
export interface FocusScopeRender {
  /** 铺在**自己的根元素**上。ref 与 `data-focus-scope` 必须一起铺,不许拆开。 */
  scopeProps: {
    ref: (el: HTMLElement | null) => void
    'data-focus-scope': FocusScopeId
    tabIndex?: -1
  }
  /** 把焦点送进这个作用域(§4.2 来源 2)。指针操作不要调:点击本身就落焦。 */
  activate: (reason?: ActivateReason) => void
  instanceId: FocusInstanceId
}

export interface FocusScopeProps {
  scope: FocusScopeId
  /** 这一份此刻不可交互(架子 keep-alive 的后台层)。缺省可交互。 */
  inert?: boolean
  /**
   * 消费方自己那格 ref —— 与树登记根元素**共用同一只回调**(见文件头)。
   * 元素上仍然只铺 `scopeProps`,不再写第二个 `ref`。
   */
  rootRef?: { current: HTMLElement | null }
  /**
   * 挂载时把焦点送进落点(浮层的「开启即入焦」)。缺省不送。
   *
   * **不叫 `autoFocus`**:那是 DOM 上那个同名属性的名字,而这一格说的是
   * 「向树申请 `activate('open')`」—— 焦点具体落到哪儿由 `restingTarget` 答。
   * 名字撞上还会当场踩 `jsx-a11y/no-autofocus`(那条规则按 prop 名认人,
   * 不管这是不是一个 DOM 元素),而那条规则说的正经事(别在页面载入时抢焦点)
   * 与这里无关:这一格只在**用户刚亲手开出一层浮层**时才用得上。
   */
  activateOnMount?: boolean
  /** 进入时焦点落在哪。答不出就落根上。 */
  restingTarget?: () => HTMLElement | null
  /** 这一层认不认 Esc。答 true = 这一下归我。**不传 = 根本不进 Esc 候选表**。 */
  onEscape?: () => boolean
  /**
   * **我此刻能做哪些命令**(K0)。键是命令 id(`keymap/commands.ts` 的那张表),
   * 不再是各面自造的动作名;声明这一头是 `FOCUS_SCOPES[scope].answers`。
   * 缺席的那一条 = 此刻答不了,派发器当没命中继续往浅走。
   */
  commands?: Readonly<Partial<Record<CommandId, (() => void) | undefined>>>
  /**
   * 这一格此刻**认领**它声明的那几个键吗(`FOCUS_SCOPES[scope].claims`)。
   * 缺省认领(`true`)。
   *
   * 它存在的唯一理由是**里面那台程序此刻在不在收键**:终端的查找框开着、光标
   * 在那只输入框里时,Win / Linux 的 `Ctrl+W` 不该被当成「给 shell 删一个词」。
   * 与 `commands[id]` 缺席同一个形 —— 声明在表上、此刻在不在由实例说。
   */
  claiming?: boolean
  /**
   * 这一格**替谁摆着**(R2)。只有 Placement 宿主层填它 —— 填它此刻装着的那块面
   * 的 item id,`activateScope(scope, { owner })` 据此在四条边的架子 / 几扇浮窗里
   * 精确取那一份(§3.5 规则 3「焦点跟着那块面走」)。内容面不填。
   */
  owner?: string
  children: (render: FocusScopeRender) => ReactNode
}

export function FocusScope(props: FocusScopeProps): ReactNode {
  const {
    scope,
    inert = false,
    rootRef,
    activateOnMount = false,
    restingTarget,
    onEscape,
    commands,
    claiming,
    owner,
    children,
  } = props
  const parent = useContext(FocusScopeContext)
  /*
   * 实例 id 由 `useId()` 给:StrictMode 的挂载→卸载→再挂载会重跑登记 effect,
   * 现发号的话渲染里已经交出去的 id 当场作废。React 的 id 与组件实例同寿。
   */
  const reactId = useId()
  const instanceId = `${scope}@${reactId}`

  /*
   * 三个声明走 ref、不进依赖表。它们通常是就地闭包,每渲染一次都是新对象 ——
   * 进依赖表等于每渲染一次就注销重登记一次,而登记序**就是树的形状**
   * (与 `ui/float.ts` 里 `onClose` 走 ref 的理由逐字相同:一个后台重渲染
   * 会把底层浮层顶到栈顶去)。
   */
  const restingRef = useRef(restingTarget)
  restingRef.current = restingTarget
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape

  /*
   * 键落点交出去的是一个**身份恒定**的对象,内容每渲染同步一次。
   * 直接把 props 里那个字面量交出去的话,树上存的是某一帧的旧闭包;
   * 而把它放进依赖表又会重登记(见上)。
   */
  const keysRef = useRef<Partial<Record<CommandId, (() => void) | undefined>>>({})
  const keysBox = keysRef.current
  for (const k of Object.keys(keysBox) as CommandId[]) {
    if (!commands || !(k in commands)) delete keysBox[k]
  }
  if (commands) Object.assign(keysBox, commands)

  const handleRef = useRef<FocusScopeHandle | null>(null)
  const rootElRef = useRef<HTMLElement | null>(null)

  /*
   * 外面那格 ref 也走 ref、不进依赖表:它通常是 `useRef` 交出来的对象(身份恒定),
   * 但条件渲染时也可能一会儿有一会儿没有,而根的登记回调必须身份恒定(见文件头)。
   */
  const outerRef = useRef(rootRef)
  outerRef.current = rootRef

  /*
   * ref 回调与登记 effect 的先后**两种都可能**:元素的 ref 在子 fiber 的提交阶段
   * 就挂上(早于本组件的 layout effect),而条件渲染时又可能反过来。
   * 所以两头各写一次:回调先把元素存进 `rootElRef`,登记完再补交一次。
   */
  const setRoot = useCallback((el: HTMLElement | null) => {
    rootElRef.current = el
    if (outerRef.current) outerRef.current.current = el
    handleRef.current?.setRoot(el)
  }, [])

  const hasEscape = Boolean(onEscape)

  useLayoutEffect(() => {
    const handle = focusTree.register(
      scope,
      parent,
      {
        inert,
        restingTarget: () => restingRef.current?.() ?? null,
        onEscape: hasEscape ? () => escapeRef.current?.() ?? false : null,
        commands: keysBox,
        claiming,
        owner,
      },
      instanceId,
    )
    handleRef.current = handle
    handle.setRoot(rootElRef.current)
    if (activateOnMount) handle.activate('open')
    return () => {
      handleRef.current = null
      handle.unregister()
    }
    /*
     * `inert` / `hasEscape` / `activateOnMount` 故意不进依赖表:前两个是**数据**,
     * 由下面两条 effect 就地改;`activateOnMount` 说的是「这一次**挂载**要不要入焦」,
     * 进依赖表等于「这个 prop 一变就再抢一次焦点」。重登记还会把 `lastFocused`
     * 一起丢掉,而「关掉什么焦点回打开它的地方」(§3.5 规则 5)全靠那一格活着。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, parent, instanceId, keysBox])

  useLayoutEffect(() => {
    handleRef.current?.update({ inert })
  }, [inert])

  /*
   * 住户换人**不是重挂**:架子那一层的 tab 换了内容、浮窗里的面被替掉,
   * 实例仍是同一格(`lastFocused` 与 `returnTo` 都该活过这一次)。所以 `owner`
   * 与 `inert` 同款,走就地改的那条路,不进登记 effect 的依赖表。
   */
  useLayoutEffect(() => {
    handleRef.current?.update({ owner })
  }, [owner])

  /*
   * 认领的开关与 `owner` / `inert` 同款:它是**数据**,一变就地改,不进登记
   * effect 的依赖表(重登记会把 `lastFocused` 与 `returnTo` 一起丢掉)。
   */
  useLayoutEffect(() => {
    handleRef.current?.update({ claiming })
  }, [claiming])

  useLayoutEffect(() => {
    handleRef.current?.update({
      onEscape: hasEscape ? () => escapeRef.current?.() ?? false : null,
    })
  }, [hasEscape])

  const activate = useCallback(
    (reason: ActivateReason = 'programmatic') => focusTree.activate(instanceId, reason),
    [instanceId],
  )

  const scopeProps: FocusScopeRender['scopeProps'] = {
    ref: setRoot,
    'data-focus-scope': scope,
    ...(focusTree.policy.moveFocus ? { tabIndex: -1 as const } : {}),
  }

  return (
    <FocusScopeContext.Provider value={instanceId}>
      {children({ scopeProps, activate, instanceId })}
    </FocusScopeContext.Provider>
  )
}
