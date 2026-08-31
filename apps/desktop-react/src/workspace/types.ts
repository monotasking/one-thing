/**
 * 工作区切换器的形状。这里只有数据,没有 React、没有 DOM —— 与 stage/ expose/
 * keymap/ 三个域同一条纪律。
 *
 * ── 一句话把这一批的边界说清 ─────────────────────────────────────────────
 * 「工作区」= 后端 `spaces` 域里的一条 `SpaceRecord`。它是**真的**:
 * 增删改查四条口都在(`packages/backend/rpc/domains/spaces.ts`)。
 * 但「当前是哪个工作区」后端**没有这个概念**(契约原话见 data/spaces-port.ts),
 * 所以它是这台壳自己的记忆,住在 localStorage。
 *
 * 于是本批的切换只有一个诚实的含义:**这台壳记住的当前工作区变了**。
 * 引擎那一侧(凭证池、接入目录、会话归属跟着空间换)属后端批 —— 界面上如实注脚,
 * 代码里不假装。
 */

/** 后端 `spaces` 域里默认空间的 id。它不许删,也不出现在「删除」那一档里。 */
export const DEFAULT_SPACE_ID = 'default'

/**
 * 色标的**取值表**。工作区的颜色不是一个自由的色值,是这六格里的一格 ——
 * 理由与「组件里不落字面色值」同源(styles/global.css 顶部铁律):
 * 用户挑的是一个**名字**,值住在 styles/palette.css 的 `--ws-*` 里。
 *
 * 存进后端 `SpaceRecord.color` 的就是这个名字。老档案里那些不认识的值
 * (或者干脆缺席)不报错、不清洗 —— 由 `swatchOf` 按 id 哈希稳定地派一个,
 * 同一个空间永远同一张脸(与 components/gradient.ts 同一条判据)。
 */
export const WORKSPACE_SWATCHES = ['violet', 'blue', 'green', 'amber', 'rose', 'teal'] as const

export type WorkspaceSwatch = (typeof WORKSPACE_SWATCHES)[number]

/**
 * 有 `⌘<数字>` 直达键的前几个工作区。三个是**键位预算**,不是能力上限:
 * 第四个之后照样能切,只是没有直达键(与「键位是稀缺资源」同一条判据,
 * 见 keymap/transitions.ts 的出厂表注释)。
 */
export const WORKSPACE_SLOT_COUNT = 3

/**
 * 屏幕上的一个工作区。**这是投影,不是状态** —— 由 `SpaceRecord[]` × 当前 id
 * 算出来,三个入口(Dock 瓦的右键快切表、⌘⇧W 命令面板、工作区总览)读的是
 * 同一份分子,所以「三处逐字同源」是结构保证,不靠自觉。
 */
export interface WorkspaceView {
  id: string
  name: string
  swatch: WorkspaceSwatch
  /** 字标:名字的第一个字。瓦面与行首的色块上画的就是它。 */
  initial: string
  isDefault: boolean
  isCurrent: boolean
  /** ⌘1…⌘3 里的那个数字;超出预算 = null(没有直达键,不是不能切)。 */
  slot: number | null
}

/** 取数的四态。`error` 时列表退成「只有默认那一个」,并如实说读不到。 */
export type WorkspaceStatus = 'idle' | 'loading' | 'ready' | 'error'
