import { isHomeRelativePath, resolveHomePath, sessionCwdOf } from '../data/files-source'
import { useSessionsSource } from '../data/sessions-source'
import { useExposeStore } from '../expose/store'
import { findItem } from '../stage/items'
import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import { CENTER_REGION, edgeRegion, floatRegion } from '../workbench/regions'
import { refId } from '../workbench/kinds'
import { regionOfRefIn, useWorkbenchStore } from '../workbench/store'
import { dirRef, normalizeDirPath } from './kinds/dir-ref'
import { notify } from '../services/notify'
import { t } from '../i18n'
import type { PlacementMemory } from '../stage/types'
import type { ContentRef } from '../workbench/kinds'
import type { RegionId } from '../workbench/regions'

/**
 * **「打开一份目录面板」这个动作**,与「files 那块瓦」分了家(2026-09-12)。
 *
 * ── 这只文件不许出现 `register*`(它存在的全部理由)────────────────────────
 * 它从 `files-launcher.tsx` 里抽出来,因为那只文件在**模块作用域**里跑
 * `registerStageLauncher(FILES_ITEM_ID, …)` —— 一句「files 瓦是启动瓦」的登记。
 * 只要有人 import 它,那句登记就发生。
 *
 * 真事故(09-12 review 打回):用户消息气泡里的 `@目录` chip 要调 `openDirectoryPanel`,
 * 于是 `ChatStream` → `user-message` → `files-launcher` 这条边长了出来,而
 * `ChatStream` 在**每一个渲染聊天的测试**的 import 闭包里 ——
 * `stage/__tests__/summon-entries.test.ts` 当场 5 红(`expected undefined to be 'float'`):
 * 那张表原本没有 files 这一行,测试量的是「没有启动瓦时按老三条路走」。
 * 病根不是测试脆,是**一个动作被关在一句登记后面**。
 *
 * 所以这只文件的纪律只有一条:**零模块级副作用** —— 没有 `register*`、没有订阅、
 * 没有定时器、没有跨渲染留存的可变状态。它因此也不需要 HMR dispose
 * (「这东西的寿命是不是这个模块实例」答否)。
 * `files-launcher.tsx` 原样 re-export 这里的两口,它的老调用方一行不用改。
 */

/** 「目录」那块启动瓦的 id(它就是从前那块「文件」瓦 —— id 不改,名字改了)。 */
export const FILES_ITEM_ID = 'files'

/**
 * 当前会话的工作目录。答不出(会话没绑目录 / 名册还没到)= null。
 *
 * **T1 起它住在这只文件**:终端那块启动瓦也要问同一句话,而从
 * `files-launcher.tsx` 里 import 它会顺手把「files 瓦是启动瓦」那句登记装进
 * 调用方的世界 —— 那正是这只文件头上记的那桩事故。`files-launcher.tsx` 原样
 * re-export,它的老调用方一行不改。
 */
export function sessionDirOf(): string | null {
  const sessionId = useExposeStore.getState().envSessionId
  return sessionCwdOf(useSessionsSource.getState().sessions, sessionId)
}

/**
 * 这块瓦此刻该把内容开到哪个区域。**记忆 > 天生**。
 *
 * `stage` / `full` 两档都落中央区:全屏不是一个住处(判词在 `stage/types.ts`),
 * 而一块目录面板铺满整扇窗不是任何人要的东西。
 */
function regionForLauncher(ref: ContentRef): RegionId {
  const stage = useStageStore.getState()
  const memory: PlacementMemory | undefined = stage.memory[FILES_ITEM_ID]
  const wanted = memory ?? findItem(FILES_ITEM_ID)?.defaultPlacement
  if (wanted?.kind === 'edge') return edgeRegion(wanted.side)
  if (wanted?.kind === 'float') {
    // 这份内容已经有一扇自己的窗就交回那一扇(同一档连点两次不该开出两扇装着
    // 同一个目录的窗)—— 与 `content/viewer/open-target.regionForMode` 同一句。
    const already = regionOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
    if (already?.startsWith('float:')) return already
    const winId = nextFloatId()
    // 身量归形态机补(默认档 + 视口钳制两件事的产地都在那儿)。
    useStageStore.getState().ensureFloatRect(winId)
    return floatRegion(winId)
  }
  return CENTER_REGION
}

/**
 * **打开一份目录面板**(启动瓦、右键最近项、「打开目录…」、消息气泡里的目录 chip、
 * 技能目录五处共用的唯一一只)。
 *
 * 四件事,次序即语义:**展开 `~`** → 归一 → 记一笔最近目录 → 摆过去。摆那一句走
 * `stage.placeRef`(它同时改树与形态机,而且经 `orchestrate` 那格缓冲 ——
 * 判词写在 `stage/store.placeRef` 上)。
 *
 * ── 第一件:入口就把 `~` 展开(09-24)──────────────────────────────────────
 * 裁定「目录面板的根永远是绝对路径」,病历整段在 `data/files-source.resolveHomePath`
 * 上:`~/…` 当 key 进了拼贴台,子层一层都展不开、面包屑画成 `/~/…`。这里是那句
 * 裁定在**新打开**这一侧的落点;已经落了盘的 `~` 格由 `content/files/HomeRootResolver`
 * 在渲染那一拍改写。`rememberRoot` 与 `placeRef` 收到的永远是绝对路径 ——
 * `referenceRoot` / `presents` / `@` 搜索根读的都是 key,key 里留着 `~` 就是三处说谎。
 *
 * ── 为什么绝对路径不绕 `resolveHomePath` 那一个微任务 ──────────────────────
 * 交互预算第①条:点击当帧必须有可见响应。绝对路径没有要问的,当拍摆好、当拍答
 * `true`(`references/kinds/dir.ts` 据此不画 pending,一格都不闪);只有 `~` 要等
 * 后端一跳。两条路问的是同一句 `isHomeRelativePath`,展开只有 `resolveHomePath`
 * 那一只 —— 判据与动作各一个产地。
 *
 * ── 答的是「开成了没有」────────────────────────────────────────────────
 * `~` 展不开 = `false`,**什么都不摆**(拿一格 `~` 去占位就是把病历重演一遍)。
 * 失败由调用方说话(chip 走它那格 `failKey`,启动瓦 / 「打开目录…」走
 * `notifyDirOpenFailed`),这里一个异常都不往外扔。
 */
export function openDirectoryPanel(rawPath: string): Promise<boolean> {
  if (!rawPath) return Promise.resolve(false)
  if (!isHomeRelativePath(rawPath)) {
    placeDirectory(rawPath)
    return Promise.resolve(true)
  }
  return resolveHomePath(rawPath).then(
    (abs) => {
      placeDirectory(abs)
      return true
    },
    () => false,
  )
}

/** 摆一份**已是绝对路径**的目录面板。只有 `openDirectoryPanel` 调它。 */
function placeDirectory(abs: string): void {
  // 身份归一(尾斜杠不是身份的一部分,判词在 `normalizeDirPath` 上)。
  const path = normalizeDirPath(abs)
  const ref = dirRef(path)
  useWorkbenchStore.getState().rememberRoot(path)
  useStageStore.getState().placeRef(ref, regionForLauncher(ref))
}

/**
 * 「这个目录没开出来」说一句话 —— 启动瓦的最近目录与「打开目录…」两条路共用
 * (它们自己没有现成的失败反馈;chip 与技能有,各走各的)。文案一处,两处不分叉。
 */
export function notifyDirOpenFailed(path: string): void {
  notify({
    level: 'warn',
    title: t('files.openDirFailed', { path }),
    source: 'files.open-dir',
    dedupeMs: 3000,
  })
}
