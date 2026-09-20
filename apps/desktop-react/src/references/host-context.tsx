import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ReferenceOpenContext } from './kind'

/**
 * **一枚引用此刻长在谁身上**(B2)。
 *
 * ── 病:`open(ref)` 只知道「点了哪一枚」,不知道「在哪一条会话里点的」 ───────
 * 命令那一种点开之后要把 `/name args` 填进**这条会话**的输入框。壳里同屏可以有
 * 好几片会话叶(W5-c 路线 A:输入框属于会话叶),所以「这条会话」既不是一个
 * 模块级单例,也不能拿「此刻焦点在哪条会话」去猜 —— 人点的是**那条消息里**的
 * 一枚 chip,收件人就是那条消息所在的会话,哪怕焦点此刻在别处。
 *
 * ── 为什么是 Context,不是层层 props ──────────────────────────────────────
 * 这一枚 chip 长在 markdown 行内树的最里面:`ChatStream` → `MessageRow` →
 * 装配管线 → `BlockView` → 段落 → `InlineRun` → `ReferenceTagChip`。要把
 * `sessionId` 穿过去,中间每一层的 props 都要多一格 —— 而中间那几层**一个都不
 * 认识引用**(`InlineRun` 里连一个种类名都不许出现)。Context 恰恰是这种
 * 「宿主的事实,中间层不参与」的形状。
 *
 * ── 缺席 = 不在任何一条会话里 ─────────────────────────────────────────────
 * 没有 Provider 的地方(独立渲染一段 markdown 的用例、将来别的宿主)读到的是
 * 一份空上下文:`open` 照旧收得到第二个参数,只是里面什么都没有,由那一种自己
 * 决定降级成什么(命令那一种答 false → chip 说一句人话)。**不造一个假的会话
 * id**:猜错的收件人比没有收件人坏得多。
 */

const EMPTY: ReferenceOpenContext = Object.freeze({})

const HostContext = createContext<ReferenceOpenContext>(EMPTY)

/**
 * 宿主自述「我这一片是哪条会话」。
 *
 * 值经 `useMemo` 按 `sessionId` 定身份 —— 每次渲染现造一个新对象会把所有
 * 消费者推着重渲一遍,而这块面里 chip 可以有几百枚(超量格)。
 */
export function ReferenceHost({
  sessionId,
  children,
}: {
  sessionId?: string
  children: ReactNode
}) {
  const value = useMemo<ReferenceOpenContext>(
    () => (sessionId ? { sessionId } : EMPTY),
    [sessionId],
  )
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>
}

/** 这一枚 chip 此刻的宿主事实。没有 Provider = 一份空的(判词在文件头)。 */
export function useReferenceHost(): ReferenceOpenContext {
  return useContext(HostContext)
}
