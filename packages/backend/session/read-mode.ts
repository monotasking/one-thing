/**
 * 会话读写档位(`docs/design/session-event-sourcing-2026-08.md` §11.1 / §14.4)。
 *
 * ## `ONETHING_SESSION_READ` —— 已退役(S3w-3 批 6b,§15.22)
 *
 * S2a 给产品读路开的那个 `messages | events` 岔口,批 8 把默认翻到 `events`,
 * `messages` 留作回滚杆。**这一批把它烧掉了** —— §15.8 表里批 6 的"唯一确认点",
 * 用户 2026-08-26 已确认。烧掉不是"顺手清理":`reads.ts` 的
 * `?? getSessionMessages(...)` 兜底半边随本批删除,`messages` 档从此只会读出一片
 * 空 —— 一根扳下去就把历史读没的杆,比没有杆危险。回滚 = `git revert`。
 *
 * 剩下的两个档位各自问一件事,所以仍然不合并:
 *  - `ONETHING_SESSION_HYDRATE` —— 冷加载时写模型从哪一侧**补水**;
 *  - (`ONETHING_SESSION_TRANSCRIPT` 也已退役,见文件末尾的墓志铭。)
 */

let foreignCoreWarned = false

/**
 * **冷加载补水**开关(S3w-1,§14.4 / §15.4)。
 *
 *   `ONETHING_SESSION_HYDRATE = 'messages' | 'projection'(默认)`
 *
 * 问的是"LRU 冷加载时,内存 store(写模型)从哪一侧**补水**"(读路已无岔口)。
 *
 * **默认已切到 `projection`**(S3w-1 批 3,§15.10):写模型的起点也换成
 * `events.jsonl` 的投影 —— §14.1 点名的"S3w 真正要换的那根梁"换完了。翻默认的
 * 前提是批 1 立的那道合同门:`bun run sessions:hydration-contract` 对全量真机
 * 会话断言「投影补水 + rehydrate + sanitize ≡ 抄本 + rehydrate + sanitize」,
 * 436 会话 pass 417 / fail 0 / 0 新类。
 *
 * **`ONETHING_SESSION_HYDRATE=messages` 是显式回滚杆**,但 S3w-3 批 6b 之后它是
 * 一根**只对存量有效、且已经不安全的杆**,留着是因为退役它不在批 6b 的授权范围
 * 内(§15.22 记了这笔账,等用户裁定):抄本自批 6a 起停写、批 6b 起写代码已删,
 * 所以 ①停写之后出生的会话没有抄本,扳过去补出来的是空; ②停写之前出生、之后
 * 又聊过的会话,抄本冻在停写那一刻,扳过去等于把那之后的历史补丢。**不要扳它**
 * ——真要回滚补水,先 `git revert` 批 6b 把抄本写回来。
 *
 * 只认两个值,拼错 = 默认:`messages` 必须被显式认出来,不能被"非 projection 即
 * 默认"吞掉。
 */
export type SessionHydrateMode = 'messages' | 'projection'

export const DEFAULT_SESSION_HYDRATE_MODE: SessionHydrateMode = 'projection'

let hydrateOverride: SessionHydrateMode | undefined

export function getSessionHydrateMode(): SessionHydrateMode {
  if (hydrateOverride) return hydrateOverride
  const raw = process.env.ONETHING_SESSION_HYDRATE?.trim().toLowerCase()
  if (raw === 'projection') return 'projection'
  if (raw === 'messages') return 'messages'
  return DEFAULT_SESSION_HYDRATE_MODE
}

export function isSessionProjectionHydrateMode(): boolean {
  return getSessionHydrateMode() === 'projection'
}

/** 仅测试:临时切补水档;传 `undefined` 归还给环境变量。 */
export function setSessionHydrateModeForTesting(mode?: SessionHydrateMode): void {
  hydrateOverride = mode
}

/*
 * ## `ONETHING_SESSION_TRANSCRIPT` —— 已退役(S3w-3 批 6b,§15.22)
 *
 * S3w-2 给抄本开的三态开关(`primary | shadow | off`),批 6a 把默认扳到 `off`、
 * 另两档降为显式回滚杆,并在那时就写下了这句预告:"批 6b 删掉 storage-driver 的
 * 消息写半边之后,这两根杆随写代码一起退役"。**兑现了** —— `writeSuffix` /
 * `rewriteAll` / `encodeSuffix` / `skipMessageWrites` 端口都已删除,一根扳不动
 * 任何东西的杆不该留在代码里假装还能回滚。回滚 = `git revert`。
 *
 * 连带的口径固化:**事件/blob 写失败上抛**(§14.6 裁定 7)从前是"`off` 档的
 * 特例",现在是**无条件的默认行为** —— `events.jsonl` 是唯一账本,写不进去不再
 * 是可吞的旁路故障。见 `event-log.ts` / `blob-store.ts` / `command-events.ts`。
 */

/**
 * R-c(§13.6):**这个 store 还有没有别的 core?**
 *
 * 产品线的历史来自 `events.jsonl`。两个写者同时往它追加时,
 * seq 是各自内存里数出来的 —— 会撞号,而 `surfaceOp: replace` 引用的正是 seq,
 * 于是遮蔽区间指向别人的事件,校验还照样放行(surface 上确实有那个 seq)。
 * 迁移脚本对这件事是**硬拦**(它要重编号整份文件);这里只**喊一声**:
 * 已经开着的桌面不该因此崩掉,而 server 撤锁的裁定仍然成立。
 *
 * 每进程喊一次(启动期调一次就够,喊多了没人看)。
 * 批 6b 起无条件喊(从前只在 `events` 读档下喊,而那个档已成唯一档)。
 *
 * @param foreignCore 宿主查出来的"另一个 core"(`run/http.json` 里那位)。
 */
export function warnOnForeignCoreForEventsRead(
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  foreignCore: { owner?: string; pid?: number; port?: number } | undefined,
): void {
  if (!foreignCore) return
  if (foreignCoreWarned) return
  foreignCoreWarned = true
  log.warn('events read mode with another live core on this store', {
    owner: foreignCore.owner,
    pid: foreignCore.pid,
    port: foreignCore.port,
    why: 'two writers mint the same event seq; replace ops then shadow the wrong range',
  })
}
