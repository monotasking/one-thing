import { DEFAULT_SPACE_ID } from './types'
import { useWorkspaceStore } from './store'

/**
 * 「当前工作区是哪一个」的**窄读面** —— 给 `data/*` 与 `providers/store.ts` 这些
 * 非组件消费者用的那一口,与 Vue 壳 `stores/spaces.ts` 导出的 `currentSpaceId()`
 * 逐字同一个角色。
 *
 * ── 为什么不让数据源直接 `useWorkspaceStore.getState()` ────────────────────
 * 因为那样每个数据源都要自己记得两件事:①「列表还没读到时 currentId 可能指向一个
 * 不存在的空间」;②「订阅要按 currentId 去重,否则改个名字也会触发一次换世界」。
 * 两件事各写一遍就会各写岔一遍 —— 判据只在这一个文件里。
 *
 * ── 「解析过的当前空间」与「记着的当前空间」是两个数 ───────────────────────
 * store 的 `currentId` 是**记着的**那一个(persist 槽里那一格,可能是别的窗口
 * 刚删掉的空间);`currentSpaceId()` 给的是**解析过的**那一个 —— 与
 * `projectWorkspaces` 的落回规则逐字相同(找不到就是默认空间),因为屏幕上的 ✓
 * 与数据源过滤的判据必须是同一个,不然会出现「列表按 ghost 空间过滤成空,而 Dock
 * 上高亮的是默认空间」。
 *
 * **列表还没读到时不落回**:`spaces` 为空只说明「还没问过后端」,不说明那个空间
 * 不存在。开机首帧就把用户记着的空间落回 default,会让会话列表先按 default 过滤
 * 一次再跳成真的那一份 —— 那正是四律里禁的那种闪。
 */

/** 解析过的当前空间 id。见文件头:列表空 = 还没问过 = 原样相信 persist 槽。 */
export function currentSpaceId(): string {
  const { spaces, currentId } = useWorkspaceStore.getState()
  if (spaces.length === 0) return currentId || DEFAULT_SPACE_ID
  return spaces.some((s) => s.id === currentId) ? currentId : DEFAULT_SPACE_ID
}

/**
 * 换世界的订阅口。**只在解析过的 id 真的变了才叫**回调 —— store 每一次写
 * (改名、换色之后的列表重读、load 的状态翻转)都会推一次订阅,不去重的话
 * 「改个色」会让会话列表、凭证池、模型表各重来一遍。
 *
 * (09-02 校正:从前这里还列着「busy 翻转」。那颗全局忙布尔已经不在 store 上了
 * ——写路的忙态迁进了 `workspace/store.ts` 的 `workspaceMutation`,它有自己的
 * 监听表,一发也推不到这条订阅上。去重仍然必须留着:列表重读照旧每写必推。)
 *
 * 回调里给的是新旧两个 id:调用方常常要拿旧的那一个去作废按空间缓存。
 */
export function subscribeCurrentSpace(
  listener: (next: string, previous: string) => void,
): () => void {
  let last = currentSpaceId()
  return useWorkspaceStore.subscribe(() => {
    const next = currentSpaceId()
    if (next === last) return
    const previous = last
    last = next
    listener(next, previous)
  })
}
