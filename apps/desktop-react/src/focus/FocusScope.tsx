import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import { focusTree } from './registry'
import './focus-scope.css'
import type { ReactNode } from 'react'
import type { FocusScopeHandle } from './registry'
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
 * 因此只交出 `activate / isActive / instanceId`,没有 `scopeProps`。
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
 * 作用域根**不画焦点环**,那条唯一的例外规则在 `focus/focus-scope.css` 里,
 * 理由写在那只文件的头上(容器不是控件)。
 *
 * ── `rootRef`:DOM 上只有一格 ref(R1 补)────────────────────────────────
 * 消费方本来就常常有自己的一个 ref(浮层要量矩形定位、要判「点没点在我身上」),
 * 而一个元素上只能写一个 `ref` 属性。就地拼一个 `(el) => { mine.current = el;
 * scopeProps.ref(el) }` 会**每渲染一次换一个身份**,React 于是每渲染都先用 null
 * 调一次再用元素调一次 —— 根一摘一挂,树看到的是「根没了又回来了」。
 * 所以由这只组件一并写:传进来的 ref 与树的登记走**同一只回调**(身份恒定)。
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
  /** 它在不在活动路径上。**别再去读 `document.activeElement` 判「我是不是当前」**。 */
  isActive: boolean
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
  /** 局部键的落点,键是 `ScopedKey.action`(表在 `focus/scopes.ts`)。 */
  keyHandlers?: Readonly<Record<string, (() => void) | undefined>>
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
    keyHandlers,
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
  const keysRef = useRef<Record<string, (() => void) | undefined>>({})
  const keysBox = keysRef.current
  for (const k of Object.keys(keysBox)) if (!keyHandlers || !(k in keyHandlers)) delete keysBox[k]
  if (keyHandlers) Object.assign(keysBox, keyHandlers)

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
        keyHandlers: keysBox,
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

  useLayoutEffect(() => {
    handleRef.current?.update({
      onEscape: hasEscape ? () => escapeRef.current?.() ?? false : null,
    })
  }, [hasEscape])

  const isActive = useSyncExternalStore(
    useCallback((listener: () => void) => focusTree.subscribe(listener), []),
    useCallback(() => focusTree.activePath().includes(instanceId), [instanceId]),
    () => false,
  )

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
      {children({ scopeProps, activate, isActive, instanceId })}
    </FocusScopeContext.Provider>
  )
}
