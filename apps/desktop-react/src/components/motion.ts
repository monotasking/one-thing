import type { MotionTier } from '../reading/types'

/**
 * 时长在 CSS 里是 token,在 JS 里得有个数 —— 定时器读不了 var()。
 * 这个文件是那些 token 在 JS 侧的唯一镜像:组件不许自己写 ms 字面量,
 * 改时长时两边一起改这一处。
 *
 * 「两边一起改」不再靠自觉:`__tests__/motion-tokens.test.ts` 把下面每一个常量
 * 与 styles/tokens.css 里的对应 token **逐条比对**,对不上当场红。
 */
export const DUR_MS = 120 // --dur
export const EXIT_MS = 120 // --dur-exit
export const RELEASE_MS = 160 // --dur-release
export const FLASH_MS = 240 // --dur-flash
export const TOOLTIP_DELAY_MS = 300 // --dur-tooltip-delay
// --dur-dock-hide-delay:自动隐藏的收回宽限,离开留驻区后缓这么久才收,路过抖动不塌
export const DOCK_HIDE_DELAY_MS = 300
/**
 * --dur-dock-wake:自动隐藏的**唤醒停留门槛** —— 指针进了贴边窄带之后要在带内
 * 连续停满这么久,藏着的 Dock 才出来(09-03 用户报障「dock 的出现太敏感」)。
 *
 * macOS 的屏幕边是**墙**:指针顶上去停在那儿是自然结果。我们的窗口边不是墙 ——
 * 去点系统 Dock、去别的窗口、去拖窗口边,每一次都要**穿过**那 8px,穿一次唤醒一次。
 * 所以门槛不是「碰到」而是「停留」:穿过去的手一次都留不住,想叫它的手停一下就出来。
 *
 * 180ms 是「一次有意的停顿」的量级(比一次穿越的 20–30ms 大一个量级,比
 * --dur-tooltip-delay 的 300ms 短 —— 唤醒一条边不该比读一句提示还慢)。
 * 它是**意图门槛**不是动画,动效档(none)不清零它,reduced-motion 也不影响它。
 */
export const DOCK_WAKE_DWELL_MS = 180
// --dur-skeleton-delay:载入骨架的出场延迟。比这更快回来的请求根本不该闪一下骨架
// (规范:150ms 内到手就当作「立刻」)。
export const SKELETON_DELAY_MS = 150
export const TOC_HOVER_MS = 150 // --dur-toc-hover:悬停多久才把目录长出来
/**
 * Esc 停止的二次确认窗口(08-31 拍板:对齐 Vue 壳 InputBox 的双击口径)。
 * 第一下只是「预备」(占位符说一句),窗口内再按才真的停 —— Esc 在退层链的
 * 末位,单次即停会让「退个抽屉多按了一下」误伤后台正跑的一轮。
 * 这是手势窗口不是动画时长,动效档(none)不清零它。
 */
export const ESC_STOP_WINDOW_MS = 2000

/**
 * 复制这类「按了没有别的可见结果」的动作,按钮就地换字/换形说「已复制」的
 * 停留时长(08-31 拍板:复制反馈不走通知 —— 反馈长在被按的那颗钮上)。
 * 这是读认窗口不是动画时长,动效档(none)不清零它。
 */
export const COPY_FEEDBACK_MS = 1500

/**
 * 滚动**停下来**多久算「停稳了,可以记一笔看到哪儿」(C1 · §5.2 的写点,
 * 正本 `docs/session-continuity-2026-09.md`)。
 *
 * 锚点从前只在离场那一拍量,而离场那一拍容器已经被 React 摘下树、几何全 0,
 * 于是这张表永远是空的(病历在 `content/ChatStream.tsx` 里那只 layout effect)。
 * 改成滚动停下来就量一次 —— **量的是还活着的那个节点**。
 *
 * 这是**读认窗口不是动画**:它答的是「人停手了没有」,动效档(none)不清零它,
 * 与 ESC_STOP_WINDOW_MS / COPY_FEEDBACK_MS 同处一族,所以没有 CSS token。
 * 120ms 的量级:比一次惯性滚动的帧间隔(16ms)大一个量级(连滚不会各量一次),
 * 比人「停下来看一眼」的反应短得多(松手到切走之间一定量得到)。
 */
export const SCROLL_ANCHOR_SETTLE_MS = 120

/**
 * --dur-dock-lens:Dock 磁性放大的**镜头开合**时长 —— 手落进条里那格
 * `--dock-amount` 从 0 走到 1、手离开时从 1 回到 0,各花这么久。
 * **它不是跟手的快慢**:跟手期那格恒为 1,几何每次 pointermove 直接写、零插值
 * (见 components/useDockLens.ts)。整条链子在 CSS 里跑完,JS 侧一个计时器都没有 ——
 * 这一行是**镜像**,由 __tests__/motion-tokens.test.ts 与 tokens.css 逐条比对,
 * 真机门 scripts/gate-dock.mjs 的入场判据也按它算几何上限。
 */
export const DOCK_LENS_MS = 140

/* ── 拖拽的三拍(W6-b,设计 `docs/workbench-tabs-2026-09.md` §4.1)────────────
 *
 * 三个都在这里而不是只镜像一个,判据与 --dur-exit 那一条逐字相同:**JS 侧有一个
 * 计时器跟着走的才进这张表**。这三个各有一个:
 *   NEIGHBOR_MS 让位过渡跑完之后要不要再量一次基准矩形(答案是不要 —— 见
 *               `ui/tab-reorder` 的判词),但**撤销让位**那一下要等它跑完再摘属性,
 *               否则邻居会从半路瞬移回去;
 *   SETTLE_MS   FLIP 跑完摘掉内联 transition / transform(与 CARD_FLIP_MS 同型);
 *   LAND_MS     卡片飞完把浮影这一格瞬态归零。
 * 产地都是 tokens.css,相等由 __tests__/motion-tokens.test.ts 逐条钉死,
 * 三个**都吃**动效档(styles/motion.css 的 calm / none 块里各有一行)。
 *
 * ── 第四拍已退役(W6-b 二修)─────────────────────────────────────────────
 * 从前这里还有一个 300ms 的门槛(它自己那格 token 也一起没了):停住多久算
 * 「我要二合一」。它先是改成由**位置**判(指针压到标签条底缘下 6–24px),
 * **U2(2026-09-08)连那条带也删了** —— 标签条上今天没有「二合一」这件事,它只在
 * 内容区左右带成立(判词在 `ui/drag/constants.ts` 的 `ONTO_FROM_PX` 退役段)。
 * 两条路身后都没有计时器,所以它既不在这张表里,也不再需要一个 token。
 * `DOCK_WAKE_DWELL_MS` 是 Dock 那件事,与它无关,照旧在上面。 */
export const NEIGHBOR_MS = 120 // --dur-neighbor
export const SETTLE_MS = 150 // --dur-settle
export const LAND_MS = 180 // --dur-land

export const TOC_FLASH_MS = 1200 // --dur-toc-flash:跳过去之后落点消息高亮多久
/**
 * 一条 toast 自动消失前活多久 —— 按级别分档(--dur-toast-success / -info / -warn)。
 * error 不在表里:它**不自动消失**,要点 ✕ 才走(见 services/notify.ts 的命运表);
 * silent 也不在表里:它根本不弹。两种缺席都是有意的 —— 表只列「会自己走的那几档」,
 * 谁不会自己走由命运表说,不在这里用一个 0 或 Infinity 冒充。
 */
export const TOAST_LIFE_MS: Record<'success' | 'info' | 'warn', number> = {
  success: 3000,
  info: 4000,
  warn: 8000,
}
// --dur-att-grace:附件摞离开后的收拢宽限。卡缝与删卡瞬间的出界不该塌摞(同 Dock 留驻区判例),
// 再进即取消。这是「宽限」不是「动画」,所以它在 JS 里有落点、在 CSS 里只是个记账。
export const ATT_GRACE_MS = 200

/* ── 动效档在 JS 侧的那一小半 ─────────────────────────────────────────────
 *
 * CSS 侧换档是换一批 --dur-*(表在 styles/motion.css),组件一行都不必知道。
 * 但有一类东西 CSS 换不掉:**跟着出场动画走的卸载定时器**。浮窗/舞台关掉时
 * 节点要多活 EXIT_MS 才卸载(出场动画得播完),这个 120 是 JS 里的一个数 ——
 * 动效档调到「无」时它必须一起变成 0,否则「关掉了却还在屏幕上待 120ms」
 * 正是用户选「无」时最不想要的那一下。
 *
 * 所以这里镜像的**只有 --dur-exit 的三档**,不是整张表:JS 侧只有它有计时器
 * 跟着。多镜像一个数就是多一处会和 CSS 说岔的地方。相等由单测钉死。
 * ────────────────────────────────────────────────────────────────────────── */

/** --dur-exit 在三档下的值(ms),与 styles/motion.css 的档位块同一张表。 */
export const EXIT_MS_BY_TIER: Record<MotionTier, number> = {
  standard: EXIT_MS,
  calm: 60,
  none: 0,
}

/**
 * 此刻的动效档 —— 从 `documentElement` 上读,不从 store 读。
 *
 * 读属性而不读 store 是有理由的:那个属性是 reading/apply.ts 贴上去的**最终结论**
 * (已经把「用户没选过时听系统的」算进去了)。让每个消费点各自再算一遍
 * 「store 的档 + 系统偏好」,就等于把那条判据抄了 N 份。
 * 拿不到 document(单测 / SSR)按 standard 算:不动的默认是照旧动,不是照旧不动。
 */
export function currentMotionTier(): MotionTier {
  if (typeof document === 'undefined') return 'standard'
  const value = document.documentElement.getAttribute('data-motion-tier')
  return value === 'calm' || value === 'none' ? value : 'standard'
}

/** 出场卸载该等多久。`none` 档下是 0 —— 关掉就是当场没有。 */
export function exitMs(): number {
  return EXIT_MS_BY_TIER[currentMotionTier()]
}

/** 活性读数(§6.6):静默超过它换成「已 N 秒没收到数据」。 */
export const STALL_SOFT_MS = 5_000
/** 活性读数:静默超过它补「可能卡住了」并把停止摆到手边。 */
export const STALL_HARD_MS = 30_000

/**
 * 快步骤不闪(§6.5 第 7 条):一步开始后这么久内就收场的(read / 瞬时工具都是),
 * **不经过 busy 形**,直接以收场形出现;真要露出 busy 形的行才用 --dur 淡入进场。
 *
 * 它是**门槛**不是动画:动效档(none)不清零它 —— 关掉动效之后,一闪而过的
 * busy 形只会更刺眼,不会更少。所以它没有 CSS token,与 ESC_STOP 一族同处。
 */
export const MIN_BUSY_MS = 250

/**
 * --dur-card-flip:工具卡结构变化(一行 → 头行 + 一行、开合抽屉、并入聚合行)时,
 * 卡高用前后两次量高做的过渡(§6.5 第 8 条 FLIP)。
 *
 * JS 侧要这个数是因为**收尾有个定时器**(过渡跑完把内联 height 摘掉)——
 * 与 --dur-exit 进 EXIT_MS_BY_TIER 同一条理由。动效档 `none` 下整段 FLIP 直接跳过
 * (`currentMotionTier()` 判),所以这里不再镜像三档,只镜像标准档那一个数;
 * 相等由 __tests__/motion-tokens.test.ts 与 tokens.css 逐条比对。
 */
export const CARD_FLIP_MS = 180
