import type { MessageKey } from '../i18n'

/**
 * 快捷键注册表的形状。和 stage/ expose/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * ── 什么进这张表,什么永远不进 ───────────────────────────────────────────────
 * 进:**命令**。一次按键 = 触发一个具名动作(呼出某块面、开关总览、收展右钉栏)。
 *     它们互相之间没有顺序、没有层次,少一个多一个都不影响别的,所以可配置。
 * 不进:**结构导航键**。它们不是命令,而是这套形态语法本身的一部分:
 *     - Esc 逐层退出(浮窗 → 舞台 → 总览 Quick Look → 总览);
 *     - 总览里的方向键 / Enter / Space(移焦、进入、Quick Look);
 *     - 浮窗的拖拽与缩放手柄。
 *     理由是同一条:它们在**每一层**都必须是同一个手感,一旦可配置,
 *     「Esc 就是退一层」这条全局承诺就没了 —— 那不是自由度,是不一致。
 *     所以这几个键住在各自的层里(ExposeView / StageOverlay / FloatWindow),
 *     不经过派发器,也不出现在设置页。
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * 一个组合键。
 *
 * key 是 KeyboardEvent.key 的**小写规范形**('p' / 'escape' / 'arrowup' / ' '),
 * 所以 'P' 与 'p' 是同一个键,大小写不再是第二种真相。
 *
 * meta 与 ctrl 在**匹配与冲突判定**里是同一件事 ——「主修饰键」在 mac 上是 ⌘、
 * 在别处是 Ctrl,同一条绑定要在两种键盘上都好使。两者的区别只活在**显示**里
 * (formatCombo 按平台选字);规则只有一条,写在 transitions 的 primaryOf 上。
 */
export interface Combo {
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  key: string
}

/**
 * 命令 id。三族:
 *  - `toggle:<itemId>` —— 每块 Dock 瓦一条(会话总览去接管化之后也在其中),
 *    语义 = togglePlacement(在 Dock 里就按它的打开方式开,在别处就收回 Dock);
 *  - `shelf.right.toggle` —— 右钉栏收 / 展;
 *  - `toc.toggle` —— 目录面板收 / 展。
 * 加命令 = 在 KEYMAP_COMMANDS 里加一行,别处零改动。
 */
export type CommandId = `toggle:${string}` | 'shelf.right.toggle' | 'toc.toggle'

export interface KeymapCommand {
  id: CommandId
  /** 命令名是界面文案,所以只持有 key —— 同 StageItemSpec.titleKey 的判例。 */
  labelKey: MessageKey
  /** 出厂绑定。null = 出厂就没绑(用户可以自己绑一个)。 */
  defaultCombo: Combo | null
}

/**
 * 只存**覆盖**。缺席 = 用后厂默认;显式的 null = 用户把它解绑了。
 * 「缺席」与「null」是两件事,所以这里不能用 `Combo | undefined` 糊过去。
 */
export interface KeymapState {
  overrides: Record<string, Combo | null>
}

/** 显示用的平台。只影响键面写 ⌘ 还是 Ctrl,不影响匹配。 */
export type KeymapPlatform = 'mac' | 'other'

/**
 * 匹配只需要这五个字段。用结构类型而不是 KeyboardEvent,
 * 是为了纯函数能在没有 DOM 的地方被测 —— 真事件天然满足它。
 */
export interface ComboEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * 录制态里一次按键的判读结果。抽成数据(而不是在组件里就地分支)
 * 的唯一理由:这四条分支要能被测。
 */
export type RecordOutcome =
  | { kind: 'ignore' }
  | { kind: 'cancel' }
  | { kind: 'unbind' }
  | { kind: 'bind'; combo: Combo }
