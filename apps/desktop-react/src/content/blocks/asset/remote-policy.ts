/**
 * 远程资产放行表 —— **一行常量说了算,一个 Set 记这一次运行**(正本 §2)。
 *
 * ── 为什么默认阻断 ────────────────────────────────────────────────────
 * `docs/stream-render-2026-09.md` §六 第 11 条的裁定:正文里的图片地址是**模型或
 * 远端写下的一句话**,自动去取它等于让一段外来文本决定这台机器发不发请求 ——
 * 请求本身就会把「这个人此刻在看这条消息」告诉那台服务器(图片是最老的那种回执
 * 像素)。所以默认不取,人点一下才取,而且**按宿主放行**:同一条消息里三十张
 * example.com 的图,点一次全通。
 *
 * 翻掉它就是把下面那一行改成 `'load'` —— 判据只有这一处,组件里一个字都不判。
 *
 * ── 为什么不落盘 ──────────────────────────────────────────────────────
 * 落盘就是一件设置(设置极简:只暴露必填项),而「这台上永远自动加载远程图片」
 * 要不要给用户一格是拍板件,不是一个 P1 顺手加的开关。今天它活一次运行,
 * 关掉壳就回到默认 —— 那是最保守的那一档,记在正本 §7 留账里。
 */
export const REMOTE_ASSET_POLICY: 'gate' | 'load' = 'gate'

/** 本次运行内被人点过「加载图片」的那些宿主。模块级 = 寿命是这个模块实例(见文末)。 */
const allowedHosts = new Set<string>()

/** 放行一个宿主。同一个宿主点第二次是幂等的 —— Set 自己就是这条纪律。 */
export function allowHost(host: string): void {
  if (host) allowedHosts.add(host)
}

export function isHostAllowed(host: string): boolean {
  return REMOTE_ASSET_POLICY === 'load' || allowedHosts.has(host)
}

/**
 * 清空。**用例与热更退役共用这一口**(CLAUDE.md:退役必须复用模块已有的那一口拆卸,
 * 不许写第二套),所以它幂等。
 */
export function resetRemotePolicyForTest(): void {
  allowedHosts.clear()
}

// 模块级可变状态的寿命是模块实例 —— 热更换掉实例时把它收走,免得旧表跟着新模块
// 一起活着(09-01 立法的那条)。生产构建里整段被摇掉。
if (import.meta.hot) {
  import.meta.hot.dispose(() => resetRemotePolicyForTest())
}
