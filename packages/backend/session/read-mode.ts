/**
 * 读模式开关(S2a,`docs/design/session-event-sourcing-2026-08.md` §11.1)。
 *
 *   `ONETHING_SESSION_READ = 'messages' | 'events'(默认)`
 *
 * **默认已切到 `events`**(S2b 批 8,§13.18):产品线的历史来自 `events.jsonl`
 * 的投影。前置全部满足才翻 —— A(批 6:settle 归位 changes)、B(批 7:事件写侧
 * 走抄本真相读)、批 9(中止在途工具的自报标题两处写侧取材归位)都已落地,
 * 双泳道 `sessions:shadow-battery` GREEN、`sessions:verify:gate` 0 新红。要回滚
 * 只需把 `ONETHING_SESSION_READ=messages` 或把这里改回 `'messages'`;messages.jsonl
 * 仍是磁盘真相(事件是投影),回滚零数据损伤。
 *
 * 单一入口的理由与 `event-stats.ts` 的总闸相同:一个"现在读的是哪一边"的
 * 问题在代码里只该有一个答案。测试用 `setSessionReadModeForTesting` 临时切,
 * 不去改进程环境变量(vitest 是同进程并发的,改 env 会串台)。
 */

export type SessionReadMode = 'messages' | 'events'

export const DEFAULT_SESSION_READ_MODE: SessionReadMode = 'events'

let override: SessionReadMode | undefined
let foreignCoreWarned = false

function fromEnv(): SessionReadMode {
  const raw = process.env.ONETHING_SESSION_READ?.trim().toLowerCase()
  // 两个值都显式认:默认已是 events(批 8),所以 `messages` 必须能把它显式
  // 扳回去(回滚杆),不能被"非 events 即默认"吞掉;其余一切 = 默认。
  if (raw === 'events') return 'events'
  if (raw === 'messages') return 'messages'
  return DEFAULT_SESSION_READ_MODE
}

export function getSessionReadMode(): SessionReadMode {
  return override ?? fromEnv()
}

export function isSessionEventsReadMode(): boolean {
  return getSessionReadMode() === 'events'
}

/** 仅测试:临时切读模式;传 `undefined` 归还给环境变量。 */
export function setSessionReadModeForTesting(mode?: SessionReadMode): void {
  override = mode
  foreignCoreWarned = false
}

/**
 * **冷加载补水**开关(S3w-1,§14.4 / §15.4)。
 *
 *   `ONETHING_SESSION_HYDRATE = 'messages' | 'projection'(默认)`
 *
 * 与上面那个开关问的**不是同一个问题**,所以不合并:
 *  - `ONETHING_SESSION_READ` 问的是"产品线的历史从哪一侧**读**";
 *  - 这一个问的是"LRU 冷加载时,内存 store(写模型)从哪一侧**补水**"。
 *
 * **默认已切到 `projection`**(S3w-1 批 3,§15.10):写模型的起点也换成
 * `events.jsonl` 的投影 —— §14.1 点名的"S3w 真正要换的那根梁"换完了。翻默认的
 * 前提是批 1 立的那道合同门:`bun run sessions:hydration-contract` 对全量真机
 * 会话断言「投影补水 + rehydrate + sanitize ≡ 抄本 + rehydrate + sanitize」,
 * 436 会话 pass 417 / fail 0 / 0 新类。
 *
 * **`ONETHING_SESSION_HYDRATE=messages` 是显式回滚杆**(回滚语义原样保留):
 * 扳回去就是老路 —— 冷加载从 `messages.jsonl` 读。抄本仍在写(S3w-2 之前它还是
 * 磁盘真相之一),所以回滚零数据损伤,不需要迁移、不需要重放。
 *
 * 只认两个值,拼错 = 默认 —— 与读开关同款:默认翻过去之后,`messages` 就是那根
 * 必须被显式认出来的回滚杆,不能被"非 projection 即默认"吞掉。
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

/**
 * **抄本(`messages.jsonl`)的三态开关**(S3w-2,§14.3-A / §14.6 裁定 5)。
 *
 *   `ONETHING_SESSION_TRANSCRIPT = 'primary' | 'shadow'(默认)| 'off'`
 *
 * 与上面两个开关问的又不是同一个问题,所以还是不合并:
 *  - `ONETHING_SESSION_READ` —— 产品线的历史从哪一侧**读**(已默认 `events`);
 *  - `ONETHING_SESSION_HYDRATE` —— 冷加载时写模型从哪一侧**补水**(已默认 `projection`);
 *  - 这一个 —— `messages.jsonl` 还**写不写**。
 *
 * 三档的语义:
 *
 * - **`primary`** —— 抄本仍被当作磁盘真相之一(S3w-2 之前的世界)。**写路径与
 *   `shadow` 完全相同**;这一档留着只为记账口径与回滚叙事:哪天要把"抄本是真相"
 *   这句话重新讲一遍,扳到这里即可,不必翻代码找它当年是什么行为。
 * - **`shadow`(默认)** —— 抄本照写,但**正式降级为纯对账影子**:产品读路
 *   (S2b)与冷加载补水(S3w-1)都已全线走投影,没有任何一条产品路径消费它;
 *   它今天的唯一用处是耐久层对账(verify #6 与 §13.16 那类真机比对)。
 * - **`off`** —— storage-driver 的**消息写半边跳过**(`meta.json` 与索引照写,
 *   §14.6 S3w-3 行),`events.jsonl` 成为唯一持久化。这一档同时是**写失败上抛**
 *   (§14.6 裁定 7)的生效条件:唯一账本写不进去不再是可吞的旁路故障。
 *
 * **本批只实现机制,默认停在 `shadow`,不切 `off`** —— 切 off 是批 6,而且是烧掉
 * `ONETHING_SESSION_READ=messages` 那条 S2b 回滚船的一步(§15.7 的唯一确认点)。
 *
 * 三个值都显式认,拼错 = 默认:`primary` 与 `off` 都是**要被显式说出口**的档,
 * 谁也不该被"非 X 即默认"吞掉。
 */
export type SessionTranscriptMode = 'primary' | 'shadow' | 'off'

export const DEFAULT_SESSION_TRANSCRIPT_MODE: SessionTranscriptMode = 'shadow'

let transcriptOverride: SessionTranscriptMode | undefined

export function getSessionTranscriptMode(): SessionTranscriptMode {
  if (transcriptOverride) return transcriptOverride
  const raw = process.env.ONETHING_SESSION_TRANSCRIPT?.trim().toLowerCase()
  if (raw === 'primary') return 'primary'
  if (raw === 'shadow') return 'shadow'
  if (raw === 'off') return 'off'
  return DEFAULT_SESSION_TRANSCRIPT_MODE
}

/** 抄本停写了吗 —— storage-driver 的消息写半边与写失败上抛共用这一个判据。 */
export function isSessionTranscriptOff(): boolean {
  return getSessionTranscriptMode() === 'off'
}

/** 仅测试:临时切抄本档;传 `undefined` 归还给环境变量。 */
export function setSessionTranscriptModeForTesting(mode?: SessionTranscriptMode): void {
  transcriptOverride = mode
}

/**
 * R-c(§13.6):**切读之前先问一句这个 store 还有没有别的 core。**
 *
 * `events` 模式下产品线的历史来自 `events.jsonl`。两个写者同时往它追加时,
 * seq 是各自内存里数出来的 —— 会撞号,而 `surfaceOp: replace` 引用的正是 seq,
 * 于是遮蔽区间指向别人的事件,校验还照样放行(surface 上确实有那个 seq)。
 * 迁移脚本对这件事是**硬拦**(它要重编号整份文件);这里只**喊一声**:
 * 已经开着的桌面不该因为一个环境变量而崩掉,而 server 撤锁的裁定仍然成立。
 *
 * 每进程喊一次(启动期调一次就够,喊多了没人看)。
 *
 * @param foreignCore 宿主查出来的"另一个 core"(`run/http.json` 里那位)。
 */
export function warnOnForeignCoreForEventsRead(
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  foreignCore: { owner?: string; pid?: number; port?: number } | undefined,
): void {
  if (!foreignCore) return
  if (!isSessionEventsReadMode()) return
  if (foreignCoreWarned) return
  foreignCoreWarned = true
  log.warn('events read mode with another live core on this store', {
    owner: foreignCore.owner,
    pid: foreignCore.pid,
    port: foreignCore.port,
    why: 'two writers mint the same event seq; replace ops then shadow the wrong range',
  })
}
