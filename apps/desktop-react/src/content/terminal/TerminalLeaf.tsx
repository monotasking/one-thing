import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { FocusScope } from '../../focus/FocusScope'
import { Button } from '../../ui/Button'
import { useT } from '../../i18n'
import { usePanelVisibility } from '../visibility'
import { useLiveTitleStore } from '../../stage/live-title'
import { refId } from '../../workbench/kinds'
import { TERMINAL_COURTESY_LETTERS, terminalPtyKeyAction } from './key-courtesy'
import { createTerminal, takeTerminalFocusRequest, terminalSessionOf } from './registry'
/*
 * **这一行是 import 副作用,不是没用的 import**:`./screen` 在模块末尾把
 * xterm 那份屏幕实现登记进注册表(判词在 `registry.ts` 的 `makeScreen` 上)。
 * 它写在这里而不是注册表里,是为了让 xterm 那条边只长在「真的要画一格终端」
 * 这条路上 —— 这只组件正是那条路的入口,而且它自己是 `lazy` 进来的。
 */
import './screen'
import { terminalCwdOf } from './terminal-memory'
import { terminalRef } from './terminal-ref'
import { useStageStore } from '../../stage/store'
import { regionOfRefIn, useWorkbenchStore } from '../../workbench/store'
import type { TerminalSession } from './session'
import s from './TerminalLeaf.module.css'

/**
 * **一格终端的身子**(T1)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期
 * ══════════════════════════════════════════════════════════════════════════
 *  · 挂载    —— 从注册表要那一格实例(没有就造 + attach),然后
 *               **只做一件事**:`appendChild(session.element)`。屏幕不是这棵
 *               React 树造的,所以它不随这次挂载生死;
 *  · 首载    —— 没有骨架。attach 那一发在飞的时候屏幕已经在了(黑的),
 *               状态条画「正在接上…」一行字 —— **禁 spinner**(禁令区第一条);
 *  · 换宿主  —— 面板内 / 浮窗 / 钉边 / 铺满四种落点:**檐、滚动、尺寸全归宿主**。
 *               这只组件自己 `height: 100%`,不画任何檐(叶檐已经有标题与关闭,
 *               再画一条就是 09-01 那桩「浮窗双檐」);滚动归 xterm 自己的视口
 *               (终端的滚动是它的语义,不是一块面板的溢出);尺寸由宿主定,
 *               这里靠 ResizeObserver 跟着量。
 *               拼贴树的结构共享保证换落点**不重挂**;真重挂了也只是把同一块
 *               DOM 再 append 一次(`appendChild` 对已在别处的节点就是搬家),
 *               屏幕内容一帧不丢;
 *  · 隐藏    —— 切走 tab = `content-visibility: hidden`,容器尺寸归零。
 *               **那时一律不 fit**(9-9),切回来补一次;
 *  · 卸载    —— `appendChild` 的那块 DOM 留在实例上,**不销毁**。真正丢一格
 *               只有关标签那一条(`closeTerminal`,种类自述里那一口)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ② UI 生命状态
 * ══════════════════════════════════════════════════════════════════════════
 *  · attaching —— 状态条「正在接上…」;屏幕已在,输入还没意义;
 *  · live      —— **状态条整行不画**(没有消息就不占地方);
 *  · detached  —— 「已断开」+「重新连接」一颗钮。屏幕停在最后一帧;
 *  · exited    —— 「进程已退出 (code N)」+「再开一个」。屏幕**保留**
 *                 (人要看最后那几行),输入由 `TerminalSession.send` 挡掉;
 *  · dead      —— 「已结束」+「在同一目录再开一个」(cwd 从本地小账本取,
 *                 取不到就退成「再开一个」—— 不编一个目录出来);
 *  · error     —— 后端那句话就地一行并陈(**零 Toast**),旧内容一像素不动;
 *  · 超量      —— 一次 `seq 1 20000`:这一层不参与(不攒不丢,判词在
 *                 `session.ts` 的 ② 那一段),长帧读数进 `gate:terminal` ⑤。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ③ UI 交互状态
 * ══════════════════════════════════════════════════════════════════════════
 *  · rest / hover / focus —— 状态条那颗钮全部由 `ui/Button` 带(配方随件走);
 *    屏幕本身的焦点环不画 —— 它是 xterm 的 textarea,焦点由响应链送进去;
 *  · pending —— 「再开一个」按下去到新一格出现之间,那颗钮自己 disabled
 *    (`busy` 一格 ref,不是全局忙布尔 —— 病型 B 的疫苗);
 *  · disabled —— `exited` / `dead` 档没有「重新连接」这颗钮(接不上的东西不给
 *    一颗灰着的钮,那是假按钮,禁令区点名过);
 *  · active —— 无(这一格没有按下去保持的态)。
 *
 * ── 焦点三件声明 ────────────────────────────────────────────────────────
 *  · scope `terminal`(`focus/scopes.ts` 加的那一行);
 *  · 落点 = 屏幕容器(键盘真正要落的是 xterm 自己的 textarea,所以 effect 里
 *    再 `session.focusScreen()` 一句 —— 那是**作用域内部**的移动,不跨作用域);
 *  · Esc **不声明** —— Esc 是 PTY 的键(vim 一秒按三次)。不进候选表 =
 *    派发器问不到人 = 不 `preventDefault` = xterm 照常把它发下去。
 *  · 局部键 = `key-courtesy.ts` 那五行,落点就是下面这张 `keyHandlers`。
 */

/** 一格实例的快照。`useSyncExternalStore` 订它自己那条线,不经任何 store。 */
function useTerminalSnapshot(session: TerminalSession) {
  return useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    useCallback(() => session.get(), [session]),
  )
}

/** 五行局部键的落点。**表驱动** —— 加一个礼让键 = `key-courtesy` 那张表加一行。 */
function courtesyHandlers(session: TerminalSession): Record<string, () => void> {
  const out: Record<string, () => void> = {}
  for (const letter of TERMINAL_COURTESY_LETTERS) {
    out[terminalPtyKeyAction(letter)] = () => session.sendCourtesyKey(letter)
  }
  return out
}

export function TerminalLeaf({ id }: { id: string }) {
  const t = useT()
  const session = terminalSessionOf(id)
  const snapshot = useTerminalSnapshot(session)
  const { visible } = usePanelVisibility()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const busyRef = useRef(false)
  /*
   * **「我是刚被人亲手开出来的那一格吗」**——一次性取走那张点名条(判词整段在
   * `registry.requestTerminalFocus` 上)。用 ref 的惰性初始化算**一次**:
   * `activateOnMount` 必须在这一格实例的生命里恒定,而且条子只该被取走一次。
   *
   * 它是 `activateOnMount` 唯一合法的用法:那一格说的是「用户刚亲手开出一层,
   * 挂载即入焦」,而这里的条件正是「用户刚亲手开出这一格」。布局恢复时冒出来的
   * 终端没被点过名,所以不抢焦点。
   */
  const openedByUser = useRef<boolean | undefined>(undefined)
  if (openedByUser.current === undefined) openedByUser.current = takeTerminalFocusRequest(id)
  const setLiveTitle = useLiveTitleStore((st) => st.setLiveTitle)

  /**
   * 屏幕搬进来。`appendChild` 对一块已经在别处的节点就是搬家 —— 不重建;
   * 卸载**不**移除:那块 DOM 归实例,下一次挂载会把它再搬一次(见 ① 卸载)。
   *
   * ── 为什么是 **ref 回调**而不是 effect(真机量出来的)────────────────────
   * ref 回调跑在**提交阶段**,effect 跑在提交之后,而**子的 effect 先于父的**
   * —— `FocusScope` 是这只组件的孩子,所以它那句 `activateOnMount` 会排在
   * 这只组件自己的 effect **之前**。写成 effect 的话次序是:落焦(容器拿到焦点、
   * `onFocus` 转交给 xterm,而那一刻 xterm 的 textarea **还不在文档里**,
   * `.focus()` 是空操作)→ 然后才 appendChild。屏幕上看是「开出来了,焦点停在
   * 那块空容器上,打字进不去」。离屏壳量到的 `activeElement` 正是那个容器。
   * 换成 ref 回调之后,屏幕先进文档,落焦才发生。
   */
  const mountScreen = useCallback(
    (host: HTMLDivElement | null) => {
      hostRef.current = host
      if (host && !host.contains(session.element)) host.appendChild(session.element)
    },
    [session],
  )

  /* 活标题:OSC → cwd 末段 → shell 名,由实例合好(`session.titleOf`)。 */
  useEffect(() => {
    const key = refId(terminalRef(id))
    if (snapshot.title) setLiveTitle(key, { text: snapshot.title, tip: snapshot.cwd })
    return () => setLiveTitle(key, null)
  }, [id, snapshot.title, snapshot.cwd, setLiveTitle])

  /*
   * 尺寸。**可见才量**(9-9):隐藏层里容器没尺寸,fit 会算出 0 列,一条
   * `resize(0,0)` 会让 PTY 重排乱屏。`session.fit()` 自己也守着这条(量不出来
   * 就什么都不做),两道判据是有意的:这里省掉一次无谓的观察回调,那里兜住
   * 「容器有尺寸但字形还没量出来」那一形。
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host || !visible) return
    session.fit()
    const observer = new ResizeObserver(() => session.fit())
    observer.observe(host)
    return () => observer.disconnect()
  }, [session, visible])

  const openAnother = useCallback(() => {
    if (busyRef.current) return
    busyRef.current = true
    const cwd = snapshot.cwd ?? terminalCwdOf(id)
    void createTerminal(cwd ? { cwd } : {})
      .then((next) => {
        // 开在**这一格原来那个区域**里(它就在屏幕上,人的眼睛正看着这儿)。
        const region = regionOfRefIn(useWorkbenchStore.getState().regions, refId(terminalRef(id)))
        useStageStore.getState().placeRef(terminalRef(next), region ?? 'center')
      })
      .finally(() => {
        busyRef.current = false
      })
  }, [id, snapshot.cwd])

  const state = snapshot.state
  const bar =
    state === 'attaching'
      ? { text: t('terminal.attaching'), action: null }
      : state === 'detached'
        ? { text: t('terminal.detached'), action: { label: t('terminal.reconnect'), run: () => void session.attach() } }
        : state === 'exited'
          ? {
              text: t('terminal.exited', { code: String(snapshot.exitCode ?? '?') }),
              action: { label: t('terminal.openAnother'), run: openAnother },
            }
          : state === 'dead'
            ? { text: t('terminal.dead'), action: { label: t('terminal.openAnother'), run: openAnother } }
            : null

  return (
    <FocusScope
      scope="terminal"
      /*
       * **一格 PTY 一份实例,所以它报 owner**(与 `chat` / `permission` 两格
       * 同一个样板:同一个 scope id 会有好几份时,`activateScope(scope, {owner})`
       * 据它精确取那一份,而不是靠 MRU 猜「最近用过的那一个」—— 刚开出来的
       * 那一格恰恰是**没被用过**的那一个)。owner = 这一格的 refId。
       */
      owner={refId(terminalRef(id))}
      activateOnMount={openedByUser.current}
      restingTarget={() => hostRef.current}
      keyHandlers={courtesyHandlers(session)}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.leaf} data-testid="terminal-leaf" data-terminal-state={state}>
          {bar && (
            <div className={s.bar} data-testid="terminal-status">
              <span>{bar.text}</span>
              {bar.action && (
                <Button onClick={bar.action.run} data-testid="terminal-status-action">
                  {bar.action.label}
                </Button>
              )}
            </div>
          )}
          {snapshot.error && (
            <div className={`${s.bar} ${s.error}`} data-testid="terminal-error">
              {snapshot.error}
            </div>
          )}
          {/*
            * 落点(三件声明的第二件)。`tabIndex={-1}` 让它自己能拿焦点,
            * 而真正接键盘的是它里面 xterm 的 textarea —— 那一步由下面这句
            * `onFocus` 交进去:**作用域内部**的移动,不跨作用域(I3)。
            */}
          <div
            ref={mountScreen}
            className={s.screen}
            data-testid="terminal-screen-host"
            tabIndex={-1}
            onFocus={() => session.focusScreen()}
          />
        </div>
      )}
    </FocusScope>
  )
}
