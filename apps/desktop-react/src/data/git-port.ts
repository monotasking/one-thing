import { resourcesRouter } from '@shared/ipc/resources'
import type { ResourceReadView } from '@shared/ipc/resources'

/**
 * 「改动」面与后端 `git:` 资源之间的那一层**端口**(正本
 * `apps/desktop-react/docs/changes-panel-2026-09.md` §3.3;照 `data/browser-port.ts`
 * 的形,**去掉 nativeView 那一口**)。
 *
 * ── 它只有一口井 ────────────────────────────────────────────────────────
 * 浏览器那只端口有两口(数据面 + 窗口系统),因为一格内嵌浏览器在壳这边真的要走
 * 两条路。改动面没有那一半:它要的每一件事都是**一次读**,而读走的是
 * `POST /api/rpc` 的 `resources` 域 —— **与 AI 同一条路**(音乐先例:真源不在壳里,
 * 壳与模型不该各走各的)。所以这一口的形状是 `resources` 那个域的形状,
 * **一个 git 的字都没有**:地址、读法名、查询全部由调用方给,表住在
 * `changes-source.ts`。
 *
 * ── 签名口径与结局口径 ──────────────────────────────────────────────────
 * 与 `browser-port.ts` / `music-port.ts` 逐字相同:位置参数进来、信封出去;
 * `read` 交**四支**,**一支都不在这一层折**(在这里把 `denied` 抛成异常,面板就
 * 再也分不出「人说了不」与「真炸了」)。折成什么形状是 `changes-source.ts` 的事。
 *
 * ── 没有 `do` ───────────────────────────────────────────────────────────
 * `git:` 本单**零做法**(写面 = stage / unstage / discard / commit 是另一张拍点表,
 * 正本 §8)。端口上不预留一口没有实现的 `do` —— 一个永远没人调的方法是下一个人的
 * 陷阱,而加它的那天正好是加第一条做法的那天。
 */

export interface GitPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /**
   * `sessionId` 是**发起坐标,不是操作对象**(操作对象在 `ref` 里 —— 契约那一句
   * 原话在 `@shared/ipc/resources.ts` 的 `ReadResourceRequest` 上)。
   *
   * **它是后端判读根的钥匙**:资源那条路的读根是「写根 ∪ 这条会话所在空间接入的
   * 目录 ∪ 笔记根 ∪ 下载目录」(`backend/wiring/resource/path-guard.ts`),而
   * 「哪一份接入目录」按发起会话取(`wiring/toolkit/runner.ts` 的 `readable(target, scope)`)。
   * 不带它,真机上任何不在**当前**空间接入表里的仓都会被拒 —— 而改动面问的恰恰
   * 是「我这条会话所在的那个仓」。
   */
  read(
    ref: string,
    name: string,
    query?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<ResourceReadView>
}

export const GIT_SCHEME_PREFIX = 'git:'

/** 一个工作目录的地址。**收的是目录,不是仓库根** —— 判词在 `kinds/diff-ref.ts`。 */
export function gitRef(workdir: string): string {
  return `${GIT_SCHEME_PREFIX}${workdir}`
}

let port: GitPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureGitPort(next: GitPort | undefined): void {
  port = next
  if (next === undefined) pending = undefined
}

/**
 * 真实现是**惰性**建的,理由与 `browser-port` / `files-port` 逐字相同:它要的是
 * 那个连通之后才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<GitPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const resources = client.api(resourcesRouter)
  return {
    ready: () => whenConnected(),
    read: (ref, name, query, sessionId) =>
      resources.read({
        ref,
        name,
        ...(query ? { query } : {}),
        // **缺席就是缺席**:空串不是一条会话 id,递下去只会让后端多判一次。
        ...(sessionId ? { sessionId } : {}),
      }),
  }
}

let pending: Promise<GitPort> | undefined

export function gitPort(): Promise<GitPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
