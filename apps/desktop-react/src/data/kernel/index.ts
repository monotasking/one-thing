/**
 * ════════════════════════════════════════════════════════════════════════════
 * 异步数据层 kernel —— 使用手册
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 零依赖的两只原语:`createQuery`(取数)与 `createMutation`(写数),外加
 * 三个 React hook。它不是一个 store,也不打算取代 zustand source ——
 * source 仍然是「领域投影 + 订阅编排」的家,kernel 接管的只是**取数与写数的
 * 生命周期**。
 *
 * ── 它存在的理由(一句话)────────────────────────────────────────────────
 * `docs/design/react-shell-2026-08.md` §8 立了四条交互稳定律。四条律**不是**
 * 给每个组件作者的自律条款 —— 08-31 的勘察结论是:病根在数据层没有把
 * 「谁在写、写的是哪一格、这是首载还是重拉」表达出来,于是每个消费者各自去猜,
 * 猜错的方式只有那么几种,同一种「闪」就在不同的面里长了很多遍。
 * 所以四律的执行落在原语上:在这里它们是**性质**,不是可以忘记打开的选项。
 *
 *   律① 写操作就地更新,重拉后台对账 → `mutation.optimistic` + `settle`
 *   律② 重拉期间旧内容保留在屏     → `query.data` 在 refetch 期间**永不清空**;
 *                                    骨架只看 `phase === 'initial'`
 *   律②′ 换键在飞时旧内容也留在屏  → `useQueryHeld(query)`(`react.ts`):律②
 *                                    只守得住**同一格**,换一把键就是换一个
 *                                    `Query`,新格天生空 —— 于是列表清空、
 *                                    容器高度归零、`scrollTop` 被钳成 0。
 *                                    垫的只有 `data` 一格,`phase/inflight/error`
 *                                    一律如实;骨架判据随之改成
 *                                    `phase === 'initial' && !stale`。
 *                                    **不是** query 的性质,是读法:哪些面要
 *                                    「换词不清屏」由消费方自己说(检索面要,
 *                                    换一坑换一份目录那种不要)。
 *   律③ 异步动作必有进行中反馈,长在发起它的那个控件上
 *                                  → `AsyncSource.isPending(key)` + `ui/AsyncButton`
 *   律④ 列表 key 稳定,禁整树重挂   → 快照身份稳定:数据没变不换引用
 *
 * ── 什么时候用 query,什么时候用 mutation ────────────────────────────────
 * · **query** = 「屏幕上这一格的答案在别处,去问」。读。可以重问、可以缓存、
 *   可以被别人标脏。判据不是「有没有网络」,是**这件事重做一遍是不是无害的**。
 * · **mutation** = 「让别处变成这样」。写。不缓存、不折叠、不自动重来。
 *
 * 用错的典型:把「保存设置」写成 query(于是它会被 invalidate 莫名其妙地
 * 再存一遍),或者把「拉目录」写成 mutation(于是两个组件各拉一发,而且
 * 换一坑回来要重拉)。
 *
 * ── 迁移一个 source 的步骤(K2/K3 照这个来)──────────────────────────────
 * 1. 找出这个 source 里的**手写状态机**:成对出现的 `xxx / xxxStatus /
 *    xxxError / xxxFetchedAt` 四件套,和那个 `inflight: Map<string, Promise>`。
 * 2. 取数那一半换成 `createQueryFamily('<域>.<名>', ctx => port.xxx(ctx.key, ctx.force))`,
 *    放在 source 隔壁一个自己的文件里(例:`providers/catalog-query.ts`)。
 *    四件套连同 `ensureXxx` 一起**删掉** —— 不留一个转发的壳,那只会变成
 *    第二份真相。
 * 3. 写那一半换成 `createMutation`:原来的「先 set 乐观值 → await → 失败 set 回去
 *    + notify」三段,分别落到 `optimistic`(返回回滚)/ `run` / `onError`;
 *    写完要重拉的那一句落到 `settle` 里的 `q.invalidate()`。
 * 4. 组件侧:`useQuery(fam.get(id))` 拿快照,骨架判 `phase === 'initial'`,
 *    小指示判 `inflight`;按钮换成 `<AsyncButton action={q} …>`。
 * 5. source 对外的选择器形状**尽量不变** —— 迁移是内部换心,不是让每个面重写。
 *
 * ── 禁止事项 ────────────────────────────────────────────────────────────
 * · 组件里**禁止** `useState` 管 async 的 pending / loading。那是 kernel 的读数,
 *   自己记一份必然与真相漂开(这条将来进壳 UI 静态门)。
 * · **禁止**把 `inflight` 当骨架的判据。骨架只看 `phase`。
 * · **禁止**在 `catch` 里清 data。错误与旧数据共存是律②的一半。
 * · **禁止**为了「保险」在 mutation 成功后整份重读并 set 回去。那是重建投影 =
 *   行身份全换 = 律④当场破。要对账就 `invalidate()`,让 query 自己去比。
 * · **禁止**用 `Object.is` 之外的 equals 去做深比较大数组 —— 那笔钱不划算;
 *   身份稳定靠的是「没变的那些次不换引用」,不是每次都深比。
 * ════════════════════════════════════════════════════════════════════════════
 */

export type { AsyncSource } from './async-source'
export { IDLE_ASYNC_SOURCE, messageOf } from './async-source'
export type { FetchContext, Query, QueryFamily, QueryFetcher, QueryOptions, QueryPhase, QuerySnapshot } from './query'
export { createQuery, createQueryFamily } from './query'
export type { Mutation, MutationOptions, MutationSnapshot, Rollback } from './mutation'
export { createMutation } from './mutation'
export type { HeldSnapshot } from './react'
export { useAsyncPending, useMutation, useQuery, useQueryHeld } from './react'
