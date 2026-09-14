/**
 * **上一次贴成功的那张变量表,存一份在 localStorage 里**(启动闪色的治法)。
 *
 * ## 病
 *
 * `theme-source.ts` 一个字节都不缓存:首帧永远画 `styles/palette.css` 的静态值
 * (暖纸 #F5F4F1),要等**连上 core → getSettings + 系统明暗 → themes.apply**
 * (后端首调才懒初始化 18 个内置主题 + 读一遍自定义主题文件)整趟回来,654 个
 * `--ui-*` 才贴上 `:root`。真店上是肉眼可见的半秒换色 —— 读者配的是 one-light
 * (#FAFAFA),开机先闪一下暖纸。
 *
 * ## 治
 *
 * 与 `reading/apply.ts`、`workspace/apply.ts` 同一条纪律:**读 localStorage、
 * 不经过 core、贴在 `createRoot` 之前,首帧就是最终值**。这只文件只管存取那一份
 * 快照;贴还是由 `theme-source.ts` 的 `applyThemeVariables` 贴(同一只函数、
 * 同一道 CSS 语法护栏),快照绕不过去。
 *
 * ## 存档当不可信输入
 *
 * localStorage 是用户机器上的一个文件:上一版壳写的旧形状、别的会话写坏的半截
 * JSON、手动改过的值,都会原样递到这里来。所以 `read()` **按形状归一**,不认就
 * 答 `null`,一个字都不抛(判例:09-13「别在跑着的桌面主检出上改迁移」——
 * 存档当不可信输入按形状归一)。读写整体 try/catch:隐私模式下 `localStorage`
 * 连取都会抛,配额满了 `setItem` 会抛 —— 那两种情况下这台壳**静默地不缓存**,
 * 退回今天的行为(首帧 palette 静态值),不是一次报错。
 */

/** 存档的版本号。形状变了就改它 —— 旧号的存档读不出来,等于没缓存。 */
const SNAPSHOT_VERSION = 1

/** 唯一的键。与其余壳级偏好同一个 `onething.` 命名空间。 */
export const THEME_SNAPSHOT_KEY = 'onething.theme.v1'

export type ThemeSnapshot = {
  v: typeof SNAPSHOT_VERSION
  themeId: string
  mode: 'dark' | 'light'
  cssVariables: Record<string, string>
}

/**
 * 只要 `localStorage` 的三个方法 —— 写成接口是为了**测试能注进来一份假的**,
 * 而不是让测试去摆弄真的 `window.localStorage`(那是全局共享状态,跨用例串味)。
 */
export interface ThemeSnapshotStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * **把任意一个 `unknown` 归一成快照,或者答 `null`** —— 纯函数,不碰 DOM、
 * 不碰存储,所以它自己就能被逐条钉死。
 *
 * 逐项检:是不是对象 / 版本号对不对 / `themeId` 是不是非空字符串 /
 * `mode` 在不在两档里 / `cssVariables` 是不是一张 string → string 的表。
 * 表里**有一个值不是字符串就整份不认** —— 半张主题表贴上去比不贴更难看
 * (缺的那些键回落到 palette 静态值,于是一屏两套色)。
 */
export function normalizeThemeSnapshot(value: unknown): ThemeSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.v !== SNAPSHOT_VERSION) return null
  if (typeof raw.themeId !== 'string' || raw.themeId.length === 0) return null
  if (raw.mode !== 'dark' && raw.mode !== 'light') return null
  const table = raw.cssVariables
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return null
  const cssVariables: Record<string, string> = {}
  for (const [name, entry] of Object.entries(table as Record<string, unknown>)) {
    if (typeof entry !== 'string') return null
    cssVariables[name] = entry
  }
  if (Object.keys(cssVariables).length === 0) return null
  return { v: SNAPSHOT_VERSION, themeId: raw.themeId, mode: raw.mode, cssVariables }
}

/**
 * 快照的存取口。一个实例 = 一份存储;缺省那一份用 `window.localStorage`。
 *
 * 存储是**惰性**取的:`window.localStorage` 这个属性本身在隐私模式 / 站点数据被
 * 禁的浏览器里就会抛,所以取它也在 try/catch 里,取不到 = 这台没有缓存这回事,
 * 读答 `null`、写什么都不做。
 */
export class ThemeSnapshotStore {
  constructor(private readonly injected?: ThemeSnapshotStorage) {}

  private storage(): ThemeSnapshotStorage | undefined {
    if (this.injected) return this.injected
    try {
      if (typeof window === 'undefined') return undefined
      return window.localStorage
    } catch {
      return undefined
    }
  }

  /** 读一份快照。没有 / 读不出 / 形状不对 → `null`,不抛。 */
  read(): ThemeSnapshot | null {
    const storage = this.storage()
    if (!storage) return null
    try {
      const text = storage.getItem(THEME_SNAPSHOT_KEY)
      if (!text) return null
      return normalizeThemeSnapshot(JSON.parse(text) as unknown)
    } catch {
      // 坏 JSON 也走这里。**不清掉**:下一次 apply 成功会整体覆盖它,
      // 而在这条读路上删东西等于让一个读操作有副作用。
      return null
    }
  }

  /** 写一份快照。写不进去(配额满 / 隐私模式)就静默作罢 —— 缓存不是正确性。 */
  write(snapshot: Omit<ThemeSnapshot, 'v'>): void {
    const storage = this.storage()
    if (!storage) return
    try {
      storage.setItem(
        THEME_SNAPSHOT_KEY,
        JSON.stringify({ v: SNAPSHOT_VERSION, ...snapshot } satisfies ThemeSnapshot),
      )
    } catch {
      /* 缓存不进去只是下次开机会闪一下,不是错 */
    }
  }

  /** 清掉。今天没有产品路径调它,留给测试与将来的「重置外观」。 */
  clear(): void {
    const storage = this.storage()
    if (!storage) return
    try {
      storage.removeItem(THEME_SNAPSHOT_KEY)
    } catch {
      /* 同上 */
    }
  }
}

/** 产品用的那一份(`window.localStorage`)。测试自己 new 一个带假存储的。 */
export const themeSnapshotStore = new ThemeSnapshotStore()
